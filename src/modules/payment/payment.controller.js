const paymentService = require('./payment.service');
const orderService = require('@modules/order/order.service');
const CustomError = require('@utils/customError');
const prisma = require('@config/prisma');
const { RECONCILABLE_PAYMENT_STATUSES } = require('@constants/payment');

exports.createOrderid = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // 🟡 Step 1: Find the latest draft order of the user
    const draftOrder = await prisma.order.findFirst({
      where: {
        userId,
        status: 'draft',
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: { orderItems: true },
    });

    if (!draftOrder || draftOrder.total <= 0) {
      throw new CustomError('No valid draft order', 401);
    }

    // 🟡 Step 2: Catch a stale draft before ever creating a Razorpay order
    // for it — a Razorpay order amount is fixed once created, so this is
    // the last point it's safe to refuse a price/stock drift, a delivery
    // address that's since been deleted, or a delivery-charge/total that no
    // longer matches the current backend pricing rule (see
    // order.service.js's detectPricingConflict), outright — before the
    // customer sees a checkout modal for an order that no longer matches
    // reality or could never actually be shipped.
    const conflicts = [
      ...(await orderService.detectAddressConflict(draftOrder.addressId, userId, undefined, 'PREPAID')),
      ...(await orderService.detectOrderConflicts(draftOrder.orderItems)),
      ...orderService.detectPricingConflict(draftOrder),
    ];
    if (conflicts.length > 0) {
      throw new CustomError(
        'Some items in your order have changed since it was created. Please refresh your order before paying.',
        409,
        { conflicts }
      );
    }

    // SECURITY INVARIANT: the amount charged is derived ONLY from
    // draftOrder.total, read from our own DB — this endpoint takes no
    // request body at all, so there is nothing client-supplied to even
    // consider trusting here. draftOrder.total is itself always
    // server-computed (see order.service.js's createDraftOrderService /
    // calculateDeliveryCharge) — never anything the frontend posts.
    // Regression-covered in payment.routes.test.js's "ignores a
    // client-supplied amount/total/deliveryCharge" test.
    const expectedAmountPaise = Math.round(draftOrder.total * 100);

    // 🟡 Step 3: Reuse-or-reconcile before ever minting a new Razorpay
    // order. This endpoint can legitimately be hit more than once for the
    // same draft order — a retry after a dropped connection, the customer
    // backing out of the Checkout.js modal and hitting Pay again, a
    // double-tap — and naively creating a fresh Razorpay order every time
    // would overwrite this order's `payment_order_id`, which is the only
    // thing /verify and the webhook use to find it again. That silently
    // orphans a payment already captured against the old id: Razorpay
    // still has the money, but nothing in our DB points at it anymore.
    if (draftOrder.payment_order_id && RECONCILABLE_PAYMENT_STATUSES.includes(draftOrder.paymentStatus)) {
      const existing = await paymentService.fetchRazorpayOrder(draftOrder.payment_order_id);

      if (existing && existing.amount === expectedAmountPaise) {
        if (existing.status === 'paid') {
          // Razorpay already captured this — our record just hasn't
          // caught up (the client that paid never got to call /verify,
          // and the webhook hasn't landed yet). Reconcile right now
          // rather than making the customer wait on the webhook or,
          // worse, letting them see a fresh checkout modal for an order
          // that's already paid.
          const payments = await paymentService.fetchOrderPayments(draftOrder.payment_order_id);
          const captured = payments.find((p) => p.status === 'captured');

          if (captured) {
            const { order } = await paymentService.updateOrderAfterPayment(
              draftOrder.payment_order_id,
              captured.id
            );
            return res.sendResponse({
              message: 'Payment already completed for this order',
              data: { alreadyPaid: true, orderId: order.id },
            });
          }
          // Razorpay says paid but we can't find the captured payment
          // (shouldn't normally happen) — fall through and let a fresh
          // attempt proceed rather than leaving the customer stuck.
        } else {
          // 'created' (never attempted) or 'attempted' (a previous try
          // failed/was abandoned, but this order id is still payable) —
          // safe to hand back as-is instead of minting a new one.
          return res.sendResponse({
            message: 'Razorpay order created successfully',
            data: { order: existing, key_id: paymentService.getGatewayPublicConfig().key_id },
          });
        }
      }
      // No usable existing order (amount drifted since it was created,
      // the lookup failed, or it ended up in some other terminal state)
      // — fall through to minting a new one below.
    }

    // 🟡 Step 4: Create a fresh Razorpay Order ID with amount. Tell it what
    // payment_order_id we read the draft order as having (possibly none) so
    // it can detect losing a race against a concurrent call for this same
    // draft order — see createRazorpayOrder's own comment for why that
    // matters here specifically.
    const created = await paymentService.createRazorpayOrder({
      amount: expectedAmountPaise,
      currency: 'INR',
      receipt: `order_${draftOrder.id}`,
      order_id: draftOrder.id,
      previousPaymentOrderId: draftOrder.payment_order_id ?? null,
    });

    if (!created.persisted) {
      // Lost the race: some other concurrent call for this same draft
      // order won and already persisted its own Razorpay order id first.
      // The order we just created on Razorpay's side was never linked to
      // this draft order, so it must never be handed to the client — if
      // they paid against it, nothing could ever find this order by that
      // id again. Fall back to whatever the winner actually persisted,
      // same as the reuse-or-reconcile path in Step 3 above.
      const current = await prisma.order.findUnique({ where: { id: draftOrder.id } });
      const winningOrder = current?.payment_order_id
        ? await paymentService.fetchRazorpayOrder(current.payment_order_id)
        : null;

      if (winningOrder) {
        return res.sendResponse({
          message: 'Razorpay order created successfully',
          data: { order: winningOrder, key_id: paymentService.getGatewayPublicConfig().key_id },
        });
      }

      // Couldn't resolve the winner either (lookup failed) — safer to ask
      // the client to retry than to hand back an order id nothing points at.
      throw new CustomError('Could not create a payment order for this draft. Please try again.', 409);
    }

    res.sendResponse({
      message: 'Razorpay order created successfully',
      data: {
        order: created.razorpayOrder,
        key_id: paymentService.getGatewayPublicConfig().key_id,
      },
    });
  } catch (error) {
    next(error);
  }
};


exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    const isValid = paymentService.verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      throw new CustomError('Invalid signature', 400);
    }

    // A valid signature proves this order_id/payment_id pair really was
    // captured by Razorpay under our account — it does NOT prove this
    // caller is who the order belongs to. Razorpay order ids aren't
    // secret (visible in browser history, dev tools, shared support
    // tickets), so without this check any authenticated user could flip
    // someone else's order to 'paid' by replaying their ids/signature.
    // Mirrors the same ownership check handleCODOrder already does for
    // the COD path.
    const owningOrder = await prisma.order.findUnique({
      where: { payment_order_id: razorpay_order_id },
      select: { userId: true, total: true },
    });

    if (!owningOrder) {
      throw new CustomError('Order not found for this payment', 404);
    }

    if (owningOrder.userId !== req.user.userId) {
      throw new CustomError('This payment does not belong to your account', 403);
    }

    // A valid signature only proves the order_id/payment_id/signature triple
    // is authentic — it does NOT independently prove Razorpay actually
    // captured money against this payment_id, or that it captured the
    // right amount. Fetch the payment straight from Razorpay (not the
    // client-supplied req.body) and check its real status/amount against
    // our own server-side order total before trusting any of this.
    const payment = await paymentService.fetchRazorpayPayment(razorpay_payment_id);

    if (!payment) {
      throw new CustomError('Unable to verify payment with Razorpay. Please try again.', 502);
    }

    if (payment.order_id !== razorpay_order_id) {
      throw new CustomError('Payment does not match this order', 400);
    }

    if (payment.status !== 'captured') {
      throw new CustomError('Payment has not been captured', 400);
    }

    const expectedAmountPaise = Math.round(owningOrder.total * 100);
    if (payment.amount !== expectedAmountPaise) {
      throw new CustomError('Payment amount does not match order total', 400);
    }

    // Idempotent: a second call for the same order (client retry, double
    // submit, or a race with the webhook) just confirms it's already paid
    // instead of re-applying the update.
    const { order, alreadyProcessed } = await paymentService.updateOrderAfterPayment(
      razorpay_order_id,
      razorpay_payment_id
    );

    res.sendResponse({
      message: alreadyProcessed
        ? 'Payment already verified'
        : 'Payment verified successfully',
      data: { success: true, alreadyProcessed, orderId: order.id },
    });
  } catch (error) {
    next(error);
  }
};

// 🔔 Razorpay webhook — the source of truth for payment status.
// Unlike /verify, this fires from Razorpay's servers whenever a payment's
// status actually changes, so it's what reconciles orders whose customer
// closed the tab (or lost network) right after paying and never called /verify.
exports.razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    // Razorpay's own header for telling two deliveries of the exact same
    // event apart from two different events — see handleRazorpayWebhookEvent
    // for why this is checked before anything else the payload says.
    const eventId = req.headers['x-razorpay-event-id'];

    if (!signature || !req.rawBody) {
      throw new CustomError('Missing signature or request body', 400);
    }

    const isValid = paymentService.verifyWebhookSignature(
      req.rawBody,
      signature
    );

    if (!isValid) {
      throw new CustomError('Invalid webhook signature', 400);
    }

    // req.body is already the parsed JSON event (see verify() in app.js,
    // which captures raw bytes alongside the normal express.json() parse).
    await paymentService.handleRazorpayWebhookEvent(req.body, eventId);

    // Razorpay retries (exponential backoff, up to ~24h) on anything but a
    // 2xx, and expects a fast response — we've already applied the update,
    // so ack now rather than doing more work on this request.
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
};

exports.placeCODOrder = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { orderId, method } = req.body;

    if (method !== 'cod') {
      throw new CustomError('Invalid method', 401);
    }

    const result = await paymentService.handleCODOrder(orderId, userId);

    res.sendResponse({
      message: result.alreadyProcessed
        ? 'COD order already placed'
        : 'COD order placed successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Explicitly cancels the in-flight payment attempt on the caller's own
 * draft order — e.g. the customer closed the Razorpay Checkout.js modal
 * without attempting anything (see paymentService.js on the frontend's
 * RazorpayCheckoutError with reason 'cancelled'). See
 * payment.service.js's cancelPaymentAttempt for exactly what this does and
 * doesn't change.
 */
exports.cancelPayment = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { orderId } = req.body;

    const result = await paymentService.cancelPaymentAttempt(orderId, userId);

    res.sendResponse({
      message: result.cancelled
        ? 'Payment attempt cancelled'
        : 'Payment attempt was already resolved',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};


