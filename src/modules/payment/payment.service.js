const prisma = require('@config/prisma');
const customError=  require('@utils/customError')
const logger = require('@config/logger');
const inventoryService = require('@modules/inventory/inventory.service');
const orderService = require('@modules/order/order.service');
const cartQueue = require('../../jobs/queues/clearCartQueue');
const notificationQueue = require('../../jobs/queues/notificationQueue');
const { PAYMENT_ATTEMPT_TIMEOUT_MS, RECONCILABLE_PAYMENT_STATUSES } = require('@constants/payment');

/**
 * Runs the fulfillment side-effects for an order that has just been marked
 * paid+confirmed (stock decrement, cart clear, confirmation notification).
 *
 * Deliberately isolated from the paymentStatus/status write that calls it
 * (see updateOrderAfterPayment and handleRazorpayWebhookEvent's
 * 'payment.captured' case): "the payment was captured and this order is
 * confirmed" and "every fulfillment side-effect for it has run" are two
 * different facts, and only the first one is what "payment success" means.
 * Razorpay has already taken the customer's money by the time either of
 * this function's callers run — that can't be undone by a bug in, say,
 * pushing a notification job — so a failure here must never be allowed to
 * read back to the caller as "the payment didn't go through" or "the order
 * wasn't created". It's caught and logged instead, as an operational
 * problem to reconcile out of band, not a payment-flow error to surface to
 * the customer.
 *
 * This matters even more for the webhook path specifically: Razorpay only
 * retries a delivery on a non-2xx response, but handleRazorpayWebhookEvent
 * de-dupes by eventId *before* this would ever run again (see the
 * WebhookEvent ledger check) — so letting an error here escape and fail
 * the webhook request wouldn't even get a retry that could fix it; it
 * would just silently drop these side-effects for good while the order
 * itself sits there already marked paid. Logging loudly and returning
 * normally is what keeps that from happening invisibly.
 */
const finalizeConfirmedOrder = async (order) => {
  try {
    const insufficient = await inventoryService.decrementStockForOrder(
      order.orderItems,
      prisma,
      { throwOnInsufficientStock: false }
    );

    if (insufficient.length > 0) {
      logger.warn(`Order ${order.id} was paid but oversold`, { orderId: order.id, insufficient });
    }

    // The cart is only cleared once payment is actually confirmed — this is
    // the first point either the /verify flow or the webhook can say that.
    await cartQueue.add('clear-cart', { userId: order.userId });
    await notificationQueue.add('order-confirmation', { orderId: order.id });
  } catch (err) {
    // The order is already correctly paid+confirmed in the DB regardless —
    // that write already committed before this function was ever called.
    // This is a fulfillment-side-effect failure (stock sync, queue/Redis
    // outage, etc.), not a payment failure, and needs an operator to look
    // at it rather than surfacing as an error to the customer or, worse,
    // this call's caller (see the comment above).
    logger.error(`Post-payment finalization failed for order ${order.id}`, {
      orderId: order.id,
      error: err?.message,
      stack: err?.stack,
    });
  }
};
// The only Razorpay-specific dependency left in this file is this line.
// Every SDK call, HMAC signature, and raw webhook/response shape lives
// behind ./gateways instead — see ./gateways/paymentGateway.contract.js for
// the full contract. Swapping providers means writing a new adapter there
// and pointing ./gateways/index.js at it, not editing anything below.
const paymentGateway = require('./gateways');

/**
 * Creates a Razorpay order and links it to our draft order.
 *
 * `previousPaymentOrderId` is a compare-and-swap guard against a duplicate
 * *creation* attempt racing itself: two concurrent create-orderid calls for
 * the same draft order (two tabs/devices submitting at once — the
 * frontend's own in-flight request dedupe in apiClient.js only covers a
 * single tab, so it can't catch this) would otherwise both mint a Razorpay
 * order and both blindly `update` the same row, with whichever write lands
 * last silently overwriting the other's payment_order_id. That orphans the
 * loser's Razorpay order: if the customer ends up paying against it,
 * neither /verify nor the webhook can ever find an order to reconcile it
 * against (both look it up by payment_order_id), so a captured payment
 * would go permanently unrecorded — exactly the kind of "duplicate payment
 * attempt" this needs to not lose. Passing the payment_order_id the caller
 * read the draft order as having *before* creating this new one, and only
 * persisting if it still matches, makes at most one of two racing calls
 * win; the loser reports `persisted: false` instead of silently clobbering
 * the winner, so the caller can fall back to whatever actually got saved
 * rather than handing the customer a Razorpay order our own DB doesn't
 * point at.
 */
exports.createRazorpayOrder = async ({
  amount,
  currency = "INR",
  receipt,
  order_id,
  previousPaymentOrderId = null,
}) => {
  try {
    // 1. Create the order with whichever gateway is configured (see
    // ./gateways) — this file never talks to Razorpay (or any other
    // provider) directly.
    const razorpayOrder = await paymentGateway.createOrder({
      amount,       // in paise
      currency,
      receipt,
    });

    // 2. Update our DB with the gateway order ID — but only if nothing
    // else has changed it since we read it (see the CAS reasoning above).
    // paymentStatus moves to 'attempted' here too: this is the moment a
    // real payment attempt exists (a Razorpay order was actually minted for
    // it), as distinct from 'pending' (a draft order that hasn't started
    // paying yet). Downstream code that used to treat "payment_order_id set
    // but paymentStatus still 'pending'" as "an attempt is in flight" reads
    // this new state instead — see createOrderid's reuse-or-reconcile check.
    const updateResult = await prisma.order.updateMany({
      where: { id: order_id, payment_order_id: previousPaymentOrderId },
      data: {
        payment_order_id: razorpayOrder.id,
        paymentStatus: 'attempted',
      },
    });

    return { razorpayOrder, persisted: updateResult.count > 0 };
  } catch (err) {

    throw new customError("Unable to create payment order.",500);
  }
};



/**
 * Looks up a previously-created payment-gateway order by id. Used by
 * createOrderid to decide whether an existing (not-yet-paid) order can be
 * reused for a retry instead of minting a new one — see the
 * reuse-or-reconcile comment there for why that matters. Resolves null
 * (rather than throwing) on any failure — an unrecognized/expired id, a
 * network blip talking to the gateway, etc. — so callers can just fall
 * through to creating a fresh order instead of having to special-case this.
 * (The gateway itself already guarantees this — see
 * ./gateways/paymentGateway.contract.js — so there's nothing left for this
 * wrapper to catch.)
 */
exports.fetchRazorpayOrder = (razorpayOrderId) => paymentGateway.fetchOrder(razorpayOrderId);

/**
 * Lists the payment attempts made against a gateway order. Used to find a
 * `captured` payment when an order comes back `status: "paid"` but our own
 * Order record hasn't been reconciled yet (the client never made it back to
 * call /verify, and the webhook hasn't landed yet either) — see
 * createOrderid. Resolves [] on failure rather than throwing, same
 * reasoning as fetchRazorpayOrder above.
 */
exports.fetchOrderPayments = (razorpayOrderId) => paymentGateway.fetchOrderPayments(razorpayOrderId);

/**
 * Fetches a payment directly from the gateway by its id. Used by /verify as
 * the independent source of truth for "was this actually captured, and for
 * how much" — a valid signature only proves the order_id/payment_id/
 * signature triple is authentic, it says nothing about whether the gateway
 * ever actually captured money against it or how much. Resolves null
 * (rather than throwing) on any failure — network blip, unrecognized id,
 * etc. — so the caller can treat "couldn't verify" as its own failure case
 * instead of a crash.
 */
exports.fetchRazorpayPayment = (paymentId) => paymentGateway.fetchPayment(paymentId);

exports.verifyRazorpaySignature = (order_id, payment_id, signature) =>
  paymentGateway.verifyPaymentSignature({ orderId: order_id, paymentId: payment_id, signature });

/**
 * Config the frontend needs to open its checkout widget for whichever
 * gateway is configured (today: `{ key_id }`, for Razorpay Checkout.js —
 * see payment.controller.js's createOrderid response). Exists so the
 * controller never reads a RAZORPAY_* env var or otherwise needs to know
 * which gateway is active — it just forwards this opaque object.
 */
exports.getGatewayPublicConfig = () => paymentGateway.publicConfig;


exports.updateOrderAfterPayment = async (order_id, payment_id) => {
  // /verify can legitimately be hit more than once — the client can retry on
  // a flaky network, double-submit, or race the async webhook hitting the
  // same order first. The filter makes the write a no-op once paymentStatus
  // is already 'paid', and since MongoDB applies a single document's update
  // atomically, only one concurrent caller ever actually wins this flip.
  const result = await prisma.order.updateMany({
    where: {
      payment_order_id: order_id,
      paymentStatus: { not: "paid" },
    },
    data: {
      paymentStatus: "paid",
      status: "confirmed",
      payment_id,
    },
  });

  const order = await prisma.order.findUnique({
    where: { payment_order_id: order_id },
    include: { orderItems: true },
  });

  if (!order) {
    throw new customError("Order not found for this payment", 404);
  }

  if (result.count > 0) {
    // This call is the one that actually flipped the order to paid (not a
    // retry/race that lost) — run fulfillment exactly once for it. Razorpay
    // has already captured the money by this point (the updateMany above
    // already committed that), so a failure anywhere in here is a
    // fulfillment problem, not a reason to tell the caller the payment
    // didn't go through — see finalizeConfirmedOrder's own comment.
    await finalizeConfirmedOrder(order);
  }

  // count === 0 means either this exact call raced a previous one and lost,
  // or /verify is simply being called again after the order was already
  // reconciled (e.g. by the webhook) — either way, already handled, not an error.
  return { order, alreadyProcessed: result.count === 0 };
};



exports.verifyWebhookSignature = (rawBody, signature) =>
  paymentGateway.verifyWebhookSignature(rawBody, signature);

/**
 * Applies a verified Razorpay webhook event to our order record. This is the
 * reconciliation path: it runs independently of whether the client ever hit
 * /api/payment/verify, so it's the one place we can trust as the source of
 * truth for "did the money actually land".
 *
 * Every branch is written to be safely re-appliable, since Razorpay retries
 * webhook delivery (same event more than once) whenever it doesn't get a 2xx.
 * That re-appliability is order-level, though (keyed on the order's current
 * paymentStatus) — it can't distinguish a genuine retry of one event from a
 * second, different event that happens to resolve to the same no-op, and it
 * keeps no record of what was actually delivered. `eventId` (Razorpay's
 * x-razorpay-event-id header — see payment.controller.js) adds a true
 * event-level check ahead of that: every verified delivery is logged to the
 * WebhookEvent ledger keyed on (source, eventId) before any handler logic
 * runs, so an exact-duplicate delivery is caught and skipped outright, and
 * the ledger itself becomes the audit trail — independent of whatever the
 * order's own row later gets overwritten with by a later event.
 *
 * `event` is the gateway's raw (already signature-verified) webhook body —
 * parseWebhookEvent (see ./gateways) is what turns it into the normalized
 * { eventType, payment } shape everything below actually works with, so
 * this function (like the rest of the file) never reads a
 * provider-specific payload shape directly.
 */
exports.handleRazorpayWebhookEvent = async (event, eventId) => {
  const { eventType, payment } = paymentGateway.parseWebhookEvent(event);

  if (eventId) {
    try {
      await prisma.webhookEvent.create({
        data: {
          source: paymentGateway.name,
          eventId,
          eventType: eventType ?? 'unknown',
          orderId: payment?.order_id ?? null,
          paymentId: payment?.id ?? null,
          payload: event,
        },
      });
    } catch (err) {
      if (err?.code === 'P2002') {
        // Already have a ledger row for this exact event id — a Razorpay
        // retry or a dashboard "resend" of a delivery we've already
        // processed. Ack without repeating anything below.
        return;
      }
      // Ledger write failed for some other reason (transient DB blip,
      // etc.) — don't let bookkeeping block reconciling a real payment;
      // fall through and rely on the order-level idempotency below, same
      // as before this ledger existed.
    }
  }

  if (!payment?.order_id) {
    // Nothing to reconcile against (e.g. non-payment events) — ack and ignore.
    return;
  }

  switch (eventType) {
    case "payment.captured": {
      // No-ops once paymentStatus is already 'paid', so a duplicate delivery
      // of this same event can't do anything unexpected.
      const result = await prisma.order.updateMany({
        where: {
          payment_order_id: payment.order_id,
          paymentStatus: { not: "paid" },
        },
        data: {
          paymentStatus: "paid",
          status: "confirmed",
          payment_id: payment.id,
        },
      });

      if (result.count > 0) {
        // Same "actually flipped it" guard as /verify — run fulfillment
        // exactly once, on whichever of /verify or this webhook won the
        // race. Wrapped by finalizeConfirmedOrder so a fulfillment failure
        // here can't throw back out of this handler: an uncaught error at
        // this point would make razorpayWebhook return a non-2xx, and
        // because the WebhookEvent ledger check above already de-dupes on
        // eventId, Razorpay's own retry of that same delivery would just
        // be swallowed as a duplicate — silently losing these side-effects
        // for good instead of ever getting a second chance to run them.
        const order = await prisma.order.findUnique({
          where: { payment_order_id: payment.order_id },
          include: { orderItems: true },
        });

        if (order) {
          await finalizeConfirmedOrder(order);
        }
      }
      break;
    }

    case "payment.authorized":
      // Authorized but not yet captured (some payment methods/flows need a
      // separate capture step before the money actually lands) — distinct
      // from both 'attempted' (nothing confirmed yet) and 'paid' (captured).
      // Only moves an attempt forward from a non-terminal state: never
      // downgrades an order a 'captured' event already marked paid (webhook
      // delivery order isn't guaranteed), and never resurrects an attempt
      // that was already explicitly cancelled or timed out.
      await prisma.order.updateMany({
        where: {
          payment_order_id: payment.order_id,
          paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
        },
        data: {
          paymentStatus: "processing",
          payment_id: payment.id,
        },
      });
      break;

    case "payment.failed":
      // Guard against ever downgrading an order a 'captured' event already
      // marked paid — Razorpay doesn't guarantee webhook delivery order.
      await prisma.order.updateMany({
        where: {
          payment_order_id: payment.order_id,
          paymentStatus: { not: "paid" },
        },
        data: {
          paymentStatus: "failed",
          payment_id: payment.id,
        },
      });
      break;

    default:
      // Other event types (refunded, order.paid, etc.) aren't needed for
      // "did the money land" reconciliation — ack and ignore so Razorpay
      // doesn't keep retrying them.
      break;
  }
};

exports.handleCODOrder = async (orderId, userId) => {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch the order to verify ownership
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { orderItems: true },
    });

    if (!order) {
      throw new customError("Order not found", 404);
    }

    if (order.userId !== userId) {
      throw new customError("Unauthorized: Order does not belong to this user", 403);
    }

    if (order.status !== "draft") {
      // Already placed — a double-submitted/retried request. Idempotent
      // no-op rather than reserving stock a second time for the same order.
      return { success: true, order, alreadyProcessed: true };
    }

    // 2. Catch a stale draft before reserving anything for it. No money has
    // moved yet for COD, so a price/stock drift, a deleted delivery
    // address, or a delivery-charge/total that no longer matches the
    // current backend pricing rule (see order.service.js's
    // detectPricingConflict — e.g. an env-level delivery-charge config
    // change since the draft order was created or last refreshed) is still
    // safe to refuse outright — this is what stops a customer from being
    // charged a price/total that's since changed (or an order being
    // confirmed with nowhere to actually ship it), and gives a clear
    // "here's exactly what changed" 409 instead of a generic stock-shortfall
    // error, or a crash later in shipping.service.js, with no useful message.
    const conflicts = [
      ...(await orderService.detectAddressConflict(order.addressId, userId, tx, 'COD')),
      ...(await orderService.detectOrderConflicts(order.orderItems, tx)),
      ...orderService.detectPricingConflict(order),
    ];
    if (conflicts.length > 0) {
      throw new customError(
        'Some items in your order have changed since it was created. Please refresh your order before placing it.',
        409,
        { conflicts }
      );
    }

    // 3. Reserve stock before confirming. No money has moved yet for COD, so
    // unlike a paid order, we can simply refuse the order outright if stock
    // isn't there — the whole transaction (this decrement included) rolls
    // back on throw, so nothing is left half-applied. This is a final
    // atomic guard against a race the conflict check above can't fully
    // close on its own (another request consuming the same stock between
    // the check above and this decrement).
    await inventoryService.decrementStockForOrder(order.orderItems, tx);

    // 4. Update the order with COD details
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "cod_pending",
        status: "confirmed",
        payment_order_id:`cod-${orderId}`
      },
    });

    // Order is confirmed at this point (COD doesn't need a separate payment
    // step) — safe to clear the cart now. Queuing outside the transaction
    // would risk clearing it even if the transaction above rolled back; this
    // line only runs once that has committed successfully.
    await cartQueue.add('clear-cart', { userId });
    await notificationQueue.add('order-confirmation', { orderId: updatedOrder.id });

    return { success: true, order: updatedOrder, alreadyProcessed: false };
  });
};

/**
 * Explicitly cancels the *payment attempt* on a draft order — e.g. the
 * customer closed the Razorpay Checkout.js modal without ever attempting a
 * payment (Razorpay has nothing to report for this, so there's no webhook
 * that would otherwise ever reconcile it — see paymentService.js on the
 * frontend's RazorpayCheckoutError with reason 'cancelled'). Without this,
 * that order would simply sit at 'attempted' until either a retry replaces
 * it or reconcileStalePaymentAttempts eventually times it out — this makes
 * the customer's own "I backed out" signal count immediately instead of
 * waiting on a stale-order sweep.
 *
 * Deliberately narrow: only cancels the attempt (paymentStatus), never the
 * order itself (status stays 'draft') — the customer can still come back
 * and pay for the same draft order, and the next createOrderid call simply
 * mints a fresh Razorpay order for it (cancelled isn't in
 * RECONCILABLE_PAYMENT_STATUSES, so it won't be reused — see createOrderid's
 * reuse-or-reconcile check).
 *
 * Idempotent: calling this again for an order that's already 'cancelled'
 * (or has since moved to any other state) is a no-op rather than an error —
 * mirrors handleCODOrder/updateOrderAfterPayment's own "already handled,
 * not a failure" treatment of a duplicate call.
 */
exports.cancelPaymentAttempt = async (orderId, userId) => {
  const order = await prisma.order.findUnique({ where: { id: orderId } });

  if (!order) {
    throw new customError('Order not found', 404);
  }
  if (order.userId !== userId) {
    throw new customError('Unauthorized: Order does not belong to this user', 403);
  }
  if (order.status !== 'draft') {
    // Already confirmed (paid/COD) or otherwise past the point a payment
    // attempt could still meaningfully be "cancelled" — nothing to do.
    throw new customError('This order is no longer awaiting payment', 409);
  }

  // Never downgrades a status this app can't safely walk back from a
  // client-reported cancel (paid/failed/timeout/unknown/cod_pending) —
  // only an attempt still genuinely in flight moves to 'cancelled' here.
  const result = await prisma.order.updateMany({
    where: {
      id: orderId,
      paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
    },
    data: { paymentStatus: 'cancelled' },
  });

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  return { order: updated, cancelled: result.count > 0 };
};

/**
 * Sweeps draft orders whose payment attempt has gone stale — still
 * pending/attempted/processing, with a Razorpay order linked, and not
 * touched in over PAYMENT_ATTEMPT_TIMEOUT_MS (see src/constants/payment.js)
 * — and resolves each one instead of leaving it in limbo forever. Meant to
 * be called periodically (see jobs/workers/paymentReconciliationWorker.js),
 * not from a request path.
 *
 * For each stale order this double-checks with Razorpay directly rather
 * than assuming the silence means the payment never happened — the same
 * "webhook/verify never landed, but the money actually did" gap
 * createOrderid's own reuse-or-reconcile logic already guards against:
 *   - Razorpay confirms it was never captured -> 'timeout'.
 *   - Razorpay confirms it WAS captured -> reconciled as paid, same as any
 *     other late reconciliation (stock decremented, cart cleared, etc. via
 *     updateOrderAfterPayment).
 *   - Razorpay can't be reached, or says paid but the captured payment
 *     can't be found -> 'unknown' rather than guessing either way, so an
 *     operator can look at it instead of a real payment silently timing out.
 *
 * Every write is a conditional updateMany keyed on the order still being in
 * a reconcilable state, so this is safe to run concurrently with a customer
 * paying/cancelling the same order at the same moment — whichever happens
 * first wins, the other becomes a no-op.
 *
 * @returns {Promise<{ timedOut: number, reconciledPaid: number, unknown: number }>}
 */
exports.reconcileStalePaymentAttempts = async () => {
  const staleBefore = new Date(Date.now() - PAYMENT_ATTEMPT_TIMEOUT_MS);

  const staleOrders = await prisma.order.findMany({
    where: {
      status: 'draft',
      paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
      payment_order_id: { not: null },
      updatedAt: { lt: staleBefore },
    },
  });

  const results = { timedOut: 0, reconciledPaid: 0, unknown: 0 };

  for (const order of staleOrders) {
    // eslint-disable-next-line no-await-in-loop
    const razorpayOrder = await exports.fetchRazorpayOrder(order.payment_order_id);

    if (!razorpayOrder) {
      // Couldn't reach Razorpay to confirm one way or the other — don't
      // guess at a real payment's fate.
      // eslint-disable-next-line no-await-in-loop
      await prisma.order.updateMany({
        where: { id: order.id, paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES } },
        data: { paymentStatus: 'unknown' },
      });
      results.unknown += 1;
      continue;
    }

    if (razorpayOrder.status === 'paid') {
      // Missed both /verify and the webhook, but Razorpay did capture the
      // money — reconcile it now rather than timing out a real payment.
      // eslint-disable-next-line no-await-in-loop
      const payments = await exports.fetchOrderPayments(order.payment_order_id);
      const captured = payments.find((p) => p.status === 'captured');

      if (captured) {
        // eslint-disable-next-line no-await-in-loop
        await exports.updateOrderAfterPayment(order.payment_order_id, captured.id);
        results.reconciledPaid += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await prisma.order.updateMany({
          where: { id: order.id, paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES } },
          data: { paymentStatus: 'unknown' },
        });
        results.unknown += 1;
      }
      continue;
    }

    // Razorpay confirms this attempt never got captured and it's been
    // stale long enough — safe to close it out.
    // eslint-disable-next-line no-await-in-loop
    await prisma.order.updateMany({
      where: { id: order.id, paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES } },
      data: { paymentStatus: 'timeout' },
    });
    results.timedOut += 1;
  }

  return results;
};
