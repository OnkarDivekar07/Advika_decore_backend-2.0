const paymentService = require('./payment.service');
const orderService = require('@modules/order/order.service');
const CustomError = require('@utils/customError');
const prisma = require('@config/prisma');

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
    // the last point it's safe to refuse a price/stock drift, or a delivery
    // address that's since been deleted, outright — before the customer
    // sees a checkout modal for an order that no longer matches reality or
    // could never actually be shipped.
    const conflicts = [
      ...(await orderService.detectAddressConflict(draftOrder.addressId, userId)),
      ...(await orderService.detectOrderConflicts(draftOrder.orderItems)),
    ];
    if (conflicts.length > 0) {
      throw new CustomError(
        'Some items in your order have changed since it was created. Please refresh your order before paying.',
        409,
        { conflicts }
      );
    }

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
    if (draftOrder.payment_order_id && draftOrder.paymentStatus === 'pending') {
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
            data: { order: existing, key_id: process.env.RAZORPAY_KEY_ID },
          });
        }
      }
      // No usable existing order (amount drifted since it was created,
      // the lookup failed, or it ended up in some other terminal state)
      // — fall through to minting a new one below.
    }

    // 🟡 Step 4: Create a fresh Razorpay Order ID with amount
    const razorpayOrder = await paymentService.createRazorpayOrder({
      amount: expectedAmountPaise,
      currency: 'INR',
      receipt: `order_${draftOrder.id}`,
      order_id: draftOrder.id,
    });

    res.sendResponse({
      message: 'Razorpay order created successfully',
      data: {
        order: razorpayOrder,
        key_id: process.env.RAZORPAY_KEY_ID,
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
      select: { userId: true },
    });

    if (!owningOrder) {
      throw new CustomError('Order not found for this payment', 404);
    }

    if (owningOrder.userId !== req.user.userId) {
      throw new CustomError('This payment does not belong to your account', 403);
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
    await paymentService.handleRazorpayWebhookEvent(req.body);

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

