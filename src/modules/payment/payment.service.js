const prisma = require('@config/prisma');
const customError = require('@utils/customError');
const logger = require('@config/logger');
const withTransactionRetry = require('@utils/withTransactionRetry');
const inventoryService = require('@modules/inventory/inventory.service');
const orderService = require('@modules/order/order.service');
const cartQueue = require('../../jobs/queues/clearCartQueue');
const notificationQueue = require('../../jobs/queues/notificationQueue');
const {
  PAYMENT_ATTEMPT_TIMEOUT_MS,
  RECONCILABLE_PAYMENT_STATUSES,
  PENDING_PAYMENT_ORDER_ID_PREFIX,
} = require('@constants/payment');

// How many times reconcileFailedFulfillments will retry a 'failed' order
// before leaving it alone for an admin to resolve by hand — retrying a
// genuinely oversold item's stock decrement can never succeed on its own no
// matter how many times it's swept, so this bounds the sweep's work on an
// order that isn't actually going to recover rather than retrying it
// forever. Plain constant, not env-driven, since — unlike
// PAYMENT_ATTEMPT_TIMEOUT_MS — there's no real operational reason to tune
// this per-deploy.
const MAX_FULFILLMENT_ATTEMPTS = 5;

/**
 * Runs the fulfillment side-effects for an order that is now durably
 * confirmed — either a captured online payment (stock decrement, cart
 * clear, confirmation notification) or a COD order that already reserved
 * its own stock transactionally (see handleCODOrder — `decrementStock:
 * false`, only cart-clear/notification are this function's job for that
 * path).
 *
 * Deliberately isolated from the paymentStatus/status write that calls it
 * (see updateOrderAfterPayment, handleRazorpayWebhookEvent's
 * 'payment.captured' case, and handleCODOrder): "the payment was captured
 * (or the COD order was placed) and this order is confirmed" and "every
 * fulfillment side-effect for it has run" are two different facts, and only
 * the first one is what "the order went through" means. Money has already
 * moved (or, for COD, stock has already been reserved and the order
 * committed) by the time any caller reaches this — that can't be undone by
 * a bug in, say, pushing a notification job — so a failure here must never
 * be allowed to read back to the caller as "the order didn't go through".
 *
 * Previously this was caught and only logged — an operational problem with
 * no durable record and nothing that ever retried it (see the "paid-order
 * fulfillment can fail permanently" review finding). Now every outcome is
 * persisted onto the order itself (fulfillmentStatus/fulfillmentError/
 * fulfillmentAttempts) so reconcileFailedFulfillments (the
 * fulfillment-reconciliation sweep — see jobs/index.js) can retry a
 * 'failed' order automatically, and admin.service.js's getOperationalAlerts
 * can surface one still failing after MAX_FULFILLMENT_ATTEMPTS for a human
 * to look at — a "paid but oversold" order in particular can never fix
 * itself by retrying, so it needs exactly this kind of visibility, not
 * just a log line.
 *
 * This matters even more for the webhook path specifically: Razorpay only
 * retries a delivery on a non-2xx response, but handleRazorpayWebhookEvent
 * de-dupes by eventId *before* this would ever run again (see the
 * WebhookEvent ledger check) — so letting an error here escape and fail
 * the webhook request wouldn't even get a retry that could fix it; it
 * would just silently drop these side-effects for good while the order
 * itself sits there already confirmed. Catching here — with the
 * reconciliation sweep as the actual retry mechanism, not Razorpay's own
 * webhook redelivery — is what keeps that from happening invisibly.
 */
const runFulfillment = async (order, { decrementStock = true } = {}) => {
  try {
    // `order.stockDecremented` guards against the one step here that is
    // NOT safe to run twice: decrementStockForOrder applies a real per-item
    // decrement every time it's called, so a retry (from
    // reconcileFailedFulfillments, after e.g. the notification enqueue
    // below failed on a first attempt that already decremented stock fine)
    // would silently double-decrement whatever already succeeded. Skipping
    // it once already recorded true is what makes retrying the rest of
    // this function safe. Always false for a COD order — its own stock
    // reservation already happened transactionally in handleCODOrder.
    if (decrementStock && !order.stockDecremented) {
      // Wrapped in its own transaction purely so a genuine infra error
      // partway through the per-item loop (not an "insufficient stock"
      // result, which decrementStockForOrder itself never throws for) can't
      // leave some items decremented and others not — it either all
      // commits together or all rolls back together, so `stockDecremented`
      // can safely mean "this ran," not "this ran, maybe partially."
      const insufficient = await withTransactionRetry((tx) =>
        inventoryService.decrementStockForOrder(order.orderItems, tx, {
          throwOnInsufficientStock: false,
        })
      );

      if (insufficient.length > 0) {
        logger.warn(`Order ${order.id} was paid but oversold`, {
          orderId: order.id,
          insufficient,
        });
      }

      order = { ...order, stockDecremented: true, oversold: order.oversold || insufficient.length > 0 };
      await prisma.order.update({
        where: { id: order.id },
        data: {
          stockDecremented: true,
          ...(insufficient.length > 0 ? { oversold: true } : {}),
        },
      });
    }

    // The cart is only cleared once the order is actually confirmed — this
    // is the first point either the /verify flow, the webhook, or COD's own
    // handleCODOrder can say that. Safe to re-run: clearing an
    // already-empty cart is a no-op, and re-enqueueing a confirmation
    // notification the customer already received is, at worst, a harmless
    // duplicate — not a reason to add per-step idempotency tracking on top
    // of the one step (stock) that actually needs it.
    await cartQueue.add('clear-cart', { userId: order.userId });
    await notificationQueue.add('order-confirmation', { orderId: order.id });

    // An oversold order can never resolve to 'completed' — the underlying
    // inventory problem doesn't go away just because the retryable queue
    // steps eventually succeeded, so it stays 'failed' (and off
    // reconcileFailedFulfillments' further attempts once
    // MAX_FULFILLMENT_ATTEMPTS is hit) until an admin resolves it by hand —
    // see `oversold`'s own schema comment.
    await prisma.order.update({
      where: { id: order.id },
      data: {
        fulfillmentAttempts: { increment: 1 },
        ...(order.oversold
          ? {
              fulfillmentStatus: 'failed',
              fulfillmentError: 'Paid but oversold — insufficient stock for one or more items in this order.',
            }
          : { fulfillmentStatus: 'completed', fulfillmentError: null }),
      },
    });
  } catch (err) {
    // The order is already correctly confirmed in the DB regardless — that
    // write already committed before this function was ever called. This
    // is a fulfillment-side-effect failure (stock sync, queue/Redis outage,
    // etc.), not an order-placement failure, and needs an operator to look
    // at it (or the sweep to retry it) rather than surfacing as an error to
    // the customer or, worse, this call's caller (see the comment above).
    logger.error(`Post-confirmation fulfillment failed for order ${order.id}`, {
      orderId: order.id,
      error: err?.message,
      stack: err?.stack,
    });

    try {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          fulfillmentStatus: 'failed',
          fulfillmentError: err?.message || 'Unknown fulfillment error',
          fulfillmentAttempts: { increment: 1 },
        },
      });
    } catch (writeErr) {
      // Best-effort on top of best-effort: if even recording the failure
      // fails (e.g. the same DB outage that caused the failure above), this
      // order simply falls back to being invisible to the sweep/alerts
      // until its next natural retry — no worse than the old
      // log-only behavior, never a reason to throw back to the caller.
      logger.error(`Could not record fulfillment failure for order ${order.id}`, {
        orderId: order.id,
        error: writeErr?.message,
      });
    }
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
  currency = 'INR',
  receipt,
  order_id,
  previousPaymentOrderId = null,
}) => {
  try {
    // 1. Create the order with whichever gateway is configured (see
    // ./gateways) — this file never talks to Razorpay (or any other
    // provider) directly.
    const razorpayOrder = await paymentGateway.createOrder({
      amount, // in paise
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
    throw new customError('Unable to create payment order.', 500);
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
exports.fetchRazorpayOrder = (razorpayOrderId) =>
  paymentGateway.fetchOrder(razorpayOrderId);

/**
 * Lists the payment attempts made against a gateway order. Used to find a
 * `captured` payment when an order comes back `status: "paid"` but our own
 * Order record hasn't been reconciled yet (the client never made it back to
 * call /verify, and the webhook hasn't landed yet either) — see
 * createOrderid. Resolves [] on failure rather than throwing, same
 * reasoning as fetchRazorpayOrder above.
 */
exports.fetchOrderPayments = (razorpayOrderId) =>
  paymentGateway.fetchOrderPayments(razorpayOrderId);

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
exports.fetchRazorpayPayment = (paymentId) =>
  paymentGateway.fetchPayment(paymentId);

exports.verifyRazorpaySignature = (order_id, payment_id, signature) =>
  paymentGateway.verifyPaymentSignature({
    orderId: order_id,
    paymentId: payment_id,
    signature,
  });

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
      paymentStatus: { not: 'paid' },
    },
    data: {
      paymentStatus: 'paid',
      status: 'confirmed',
      payment_id,
    },
  });

  const order = await prisma.order.findUnique({
    where: { payment_order_id: order_id },
    include: { orderItems: true },
  });

  if (!order) {
    throw new customError('Order not found for this payment', 404);
  }

  if (result.count > 0) {
    // This call is the one that actually flipped the order to paid (not a
    // retry/race that lost) — run fulfillment exactly once for it. Razorpay
    // has already captured the money by this point (the updateMany above
    // already committed that), so a failure anywhere in here is a
    // fulfillment problem, not a reason to tell the caller the payment
    // didn't go through — see runFulfillment's own comment.
    await runFulfillment(order);
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
  const { eventType, payment, refund } = paymentGateway.parseWebhookEvent(event);

  // Refund-lifecycle events don't carry a `payment` entity the same way
  // payment.captured/authorized/failed do (see razorpay.gateway.js's
  // parseWebhookEvent) — reconciled by payment_id instead, in its own
  // branch below, before the payment-keyed early-return would otherwise
  // treat these as "nothing to reconcile" and drop them.
  if (eventType === 'refund.processed' || eventType === 'refund.failed') {
    if (!refund?.payment_id) return;

    let flippedRefund = false;
    let duplicateRefundDelivery = false;

    await withTransactionRetry(async (tx) => {
      if (eventId) {
        try {
          await tx.webhookEvent.create({
            data: {
              source: paymentGateway.name,
              eventId,
              eventType,
              orderId: null,
              paymentId: refund.payment_id,
              payload: event,
            },
          });
        } catch (err) {
          if (err?.code === 'P2002') {
            duplicateRefundDelivery = true;
            return;
          }
          // Same fallback as the payment path below: don't let a ledger
          // write failure block reconciling a real refund.
        }
      }

      // Looks up the RefundAttempt this event's refund.id belongs to (see
      // prisma/schema.prisma's RefundAttempt model and refundOrderPayment's
      // own comment on why it exists) so this can match the order by `id`
      // directly — durable and correct even if refundOrderPayment's own
      // `paymentStatus: 'refund_pending'` write never landed (the "refund
      // has a failure window" review finding this closes). Falls back to
      // the old payment_id + 'refund_pending'-only match for a refund this
      // ledger doesn't know about (e.g. one initiated before this model
      // existed) — additive, not a narrowing of what this could already do.
      const attempt = refund?.id
        ? await tx.refundAttempt.findUnique({ where: { refundId: refund.id } })
        : null;

      const orderData =
        eventType === 'refund.processed'
          ? { paymentStatus: 'refunded', status: 'cancelled' }
          : { paymentStatus: 'refund_failed' };

      // Either path's WHERE clause is what makes "did THIS call win the
      // race to reconcile this order" safe under concurrent/duplicate
      // webhook deliveries — the stock restore + status flip below only
      // ever run once, guarded by `result.count > 0`, not a separate
      // find-then-update that could race a second delivery. Matching by
      // `id` when a RefundAttempt is known additionally guards against
      // resurrecting an order already settled some other way, the same
      // way the payment_id fallback's `paymentStatus: 'refund_pending'`
      // condition always did.
      //
      // `status` only ever moves to 'cancelled' — and stock is only ever
      // restored — once refund.processed genuinely confirms the money
      // moved. Previously refundOrderPayment did both of those eagerly, at
      // the moment the refund was merely *initiated* (Razorpay accepting
      // the request is not the same as it completing — see the "refund
      // failure can create an incorrect business state" review finding
      // this closes): a later refund.failed left the order permanently
      // marked cancelled with its stock already given back to sell to
      // someone else, even though the original customer never actually
      // got their money back. A failed refund now leaves `status`
      // untouched (still whatever it was — 'confirmed', 'shipped', etc.)
      // and stock exactly where it was, so nothing about the order is
      // wrong while an admin (via getOperationalAlerts' payment
      // exceptions, which now includes 'refund_failed') sorts it out.
      const result = attempt
        ? await tx.order.updateMany({
            where: { id: attempt.orderId, paymentStatus: { in: ['paid', 'refund_pending'] } },
            data: orderData,
          })
        : await tx.order.updateMany({
            where: { payment_id: refund.payment_id, paymentStatus: 'refund_pending' },
            data: orderData,
          });
      flippedRefund = result.count > 0;

      if (attempt) {
        await tx.refundAttempt.update({
          where: { id: attempt.id },
          data: {
            status: eventType === 'refund.processed' ? 'completed' : 'failed',
            processedAt: new Date(),
          },
        });
      }

      if (flippedRefund && eventType === 'refund.processed') {
        const order = attempt
          ? await tx.order.findUnique({ where: { id: attempt.orderId }, include: { orderItems: true } })
          : await tx.order.findFirst({ where: { payment_id: refund.payment_id }, include: { orderItems: true } });
        if (order) {
          await inventoryService.restoreStockForOrder(order.orderItems, tx);
        }
      }
    });

    if (duplicateRefundDelivery || !flippedRefund) return;

    logger.info(
      `[payment] Refund ${refund.id} for payment ${refund.payment_id} reconciled as ${eventType === 'refund.processed' ? 'refunded' : 'refund_failed'}`
    );
    return;
  }

  if (!payment?.order_id) {
    // Nothing to reconcile against (e.g. non-payment events) — ack and
    // ignore. Deliberately checked before the ledger write: an event with
    // nothing to reconcile has nothing worth recording either.
    return;
  }

  // The ledger write and the order mutation below run inside ONE
  // transaction so a crash between them can't happen. Previously these
  // were two independent top-level `await`s: a process crash/restart
  // after the ledger insert committed but before `order.updateMany` ran
  // would permanently "eat" that event's side effect — the ledger's own
  // (source, eventId) uniqueness check would treat any later retry of the
  // exact same delivery as an already-processed duplicate and skip it
  // forever, even though the order was never actually updated. Wrapping
  // both in `prisma.$transaction` makes "ledger says processed" and "the
  // order mutation actually happened" atomic together.
  //
  // `flipped` communicates outward whether *this* call actually moved
  // `payment.captured`'s order from unpaid to paid — fulfillment
  // (runFulfillment) deliberately runs *after* the transaction
  // commits, not inside it: queueing BullMQ jobs from inside a DB
  // transaction risks fulfillment being scheduled for a write that then
  // rolls back, and a fulfillment failure must never be able to roll back
  // a real, already-committed payment confirmation.
  let flipped = false;
  let duplicateDelivery = false;

  await withTransactionRetry(async (tx) => {
    if (eventId) {
      try {
        await tx.webhookEvent.create({
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
          // processed. Skip the mutation below; the transaction commits
          // as a no-op.
          duplicateDelivery = true;
          return;
        }
        // Ledger write failed for some other reason (transient DB blip,
        // etc.) — don't let bookkeeping block reconciling a real payment;
        // fall through and still apply the order mutation below, same
        // "rely on order-level idempotency" fallback as before this
        // ledger existed. The ledger row simply won't exist for this
        // delivery, same as it wouldn't have before this change.
      }
    }

    switch (eventType) {
      case 'payment.captured': {
        // No-ops once paymentStatus is already 'paid', so a duplicate
        // delivery of this same event can't do anything unexpected.
        const result = await tx.order.updateMany({
          where: {
            payment_order_id: payment.order_id,
            paymentStatus: { not: 'paid' },
          },
          data: {
            paymentStatus: 'paid',
            status: 'confirmed',
            payment_id: payment.id,
          },
        });
        flipped = result.count > 0;
        break;
      }

      case 'payment.authorized':
        // Authorized but not yet captured (some payment methods/flows need a
        // separate capture step before the money actually lands) — distinct
        // from both 'attempted' (nothing confirmed yet) and 'paid' (captured).
        // Only moves an attempt forward from a non-terminal state: never
        // downgrades an order a 'captured' event already marked paid (webhook
        // delivery order isn't guaranteed), and never resurrects an attempt
        // that was already explicitly cancelled or timed out.
        await tx.order.updateMany({
          where: {
            payment_order_id: payment.order_id,
            paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
          },
          data: {
            paymentStatus: 'processing',
            payment_id: payment.id,
          },
        });
        break;

      case 'payment.failed':
        // Guard against ever downgrading an order a 'captured' event already
        // marked paid — Razorpay doesn't guarantee webhook delivery order.
        await tx.order.updateMany({
          where: {
            payment_order_id: payment.order_id,
            paymentStatus: { not: 'paid' },
          },
          data: {
            paymentStatus: 'failed',
            payment_id: payment.id,
          },
        });
        break;

      default:
        // Other event types (order.paid, etc. — refund.processed/
        // refund.failed are handled in their own branch above this
        // switch, not here) aren't needed for "did the money land"
        // reconciliation — ack and ignore so Razorpay doesn't keep
        // retrying them.
        break;
    }
  });

  if (duplicateDelivery || !flipped) return;

  // Same "actually flipped it" guard as /verify — run fulfillment exactly
  // once, on whichever of /verify or this webhook won the race. Wrapped by
  // runFulfillment so a fulfillment failure here can't throw back out of
  // this handler: an uncaught error at this point would make
  // razorpayWebhook return a non-2xx, and because the WebhookEvent ledger
  // check above already de-dupes on eventId, Razorpay's own retry of that
  // same delivery would just be swallowed as a duplicate — silently losing
  // these side-effects for good instead of ever getting a second chance to
  // run them. reconcileFailedFulfillments is what actually gets that
  // second chance now, not Razorpay's own redelivery.
  const order = await prisma.order.findUnique({
    where: { payment_order_id: payment.order_id },
    include: { orderItems: true },
  });

  if (order) {
    await runFulfillment(order);
  }
};

exports.handleCODOrder = async (orderId, userId) => {
  const result = await withTransactionRetry(async (tx) => {
    // 1. Fetch the order to verify ownership
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { orderItems: true },
    });

    if (!order) {
      throw new customError('Order not found', 404);
    }

    if (order.userId !== userId) {
      throw new customError(
        'Unauthorized: Order does not belong to this user',
        403
      );
    }

    if (order.status !== 'draft') {
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
      ...(await orderService.detectAddressConflict(
        order.addressId,
        userId,
        tx,
        'COD'
      )),
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
        paymentStatus: 'cod_pending',
        status: 'confirmed',
        payment_order_id: `cod-${orderId}`,
      },
    });

    return { success: true, order: updatedOrder, alreadyProcessed: false };
  });

  // Cart-clear + confirmation notification run after the transaction has
  // committed (never inside it — same reasoning as the online-payment
  // path's own comment on this: queueing BullMQ jobs from inside a DB
  // transaction risks fulfillment being scheduled for a write that then
  // rolls back). Previously these two calls sat inside the transaction
  // with no try/catch at all — a Redis hiccup here would have thrown back
  // out of handleCODOrder and 500'd the checkout request even though the
  // order had already committed as confirmed. Routing through
  // runFulfillment (decrementStock: false — COD already reserved its stock
  // transactionally above, under a real throw-on-shortfall guard, so
  // there's nothing left for this call to decrement or oversell) gives COD
  // the same durable failure-tracking/retry the online-payment path has,
  // instead of a customer-facing 500 for an order that actually succeeded.
  if (!result.alreadyProcessed) {
    // `userId` spread in explicitly rather than relying on
    // result.order.userId — tx.order.update's real return already carries
    // it (it's an unchanged field on the document), but this is one call
    // worth not leaving to an assumption about what a DB write happens to
    // return.
    await runFulfillment(
      { ...result.order, userId },
      { decrementStock: false }
    );
  }

  return result;
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
    throw new customError(
      'Unauthorized: Order does not belong to this user',
      403
    );
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
 * Admin-triggered: refunds a paid order's full amount via the payment
 * gateway and cancels the order, restoring stock. This is the actual
 * "contact support" capability behind cancelOrderByCustomer's message —
 * that endpoint only tells a customer with a paid-online order to reach
 * out; an admin acting on that request calls this. Scoped to orders that
 * haven't shipped yet (order.service.js's CANCELLABLE_ORDER_STATUSES,
 * reused here rather than duplicated) — an already-shipped order needing
 * money back (a return/RTO) is a different, not-yet-built flow, not this
 * one; refunding one mid-transit would leave a real shipment orphaned
 * with nothing tracking it back to a live order.
 *
 * paymentStatus moves to 'refund_pending' immediately, not 'refunded' —
 * initiating a refund isn't the same as Razorpay actually completing it
 * (refunds are asynchronous on their side); only the
 * refund.processed/refund.failed webhook (handleRazorpayWebhookEvent
 * below) ever moves it on from there. See
 * prisma/schema.prisma's PaymentStatus comment for the full state
 * diagram.
 *
 * `status` is deliberately left untouched here — still whatever it was
 * ('confirmed', 'shipped', etc.) — and stock is NOT restored yet either.
 * Both only happen once handleRazorpayWebhookEvent's refund.processed
 * branch (or reconcileUnresolvedRefunds, below) confirms the refund
 * genuinely completed. An earlier version of this function did both
 * eagerly, on the theory that "the refund was *requested*" was enough to
 * call the order done — but Razorpay accepting a refund request only
 * means it was *initiated*, not that it will succeed (see refundPayment's
 * own doc comment). A later refund.failed would have left the order
 * permanently marked 'cancelled' with its stock already restored
 * (sellable to someone else) while the original customer never actually
 * got their money back — a real customer-money-at-risk bug (see the
 * "refund failure can create an incorrect business state" review finding
 * this fixes). Only `paymentStatus` moves here, to 'refund_pending' — the
 * one thing that's true immediately: a refund is now in flight against
 * this payment, whatever the eventual outcome.
 *
 * A RefundAttempt row (see prisma/schema.prisma) is created BEFORE the
 * real Razorpay call below, and is what closes a second, narrower gap:
 * Razorpay can genuinely process the refund, and then the `paymentStatus:
 * 'refund_pending'` write further down can independently fail (a DB blip,
 * a crash) — leaving the order looking untouched ('paid') even though the
 * customer's money already moved. handleRazorpayWebhookEvent's own
 * reconciliation only ever matches an order already at 'refund_pending',
 * so it can't repair that on its own. reconcileUnresolvedRefunds (the
 * sweep) can, because it works from this durable, independently-written
 * record instead of trusting Order's own fields to have landed (see the
 * "refund has a failure window" review finding this fixes).
 */
exports.refundOrderPayment = async (orderId, adminUserId, reason) => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      payment_id: true,
      total: true,
      orderItems: { select: { productId: true, quantity: true } },
    },
  });

  if (!order) {
    throw new customError('Order not found', 404);
  }
  if (order.paymentStatus !== 'paid') {
    throw new customError(
      `Cannot refund an order with payment status '${order.paymentStatus}' — only a fully paid order can be refunded this way.`,
      400
    );
  }
  if (!order.payment_id) {
    // Shouldn't happen for a genuinely 'paid' order (payment_id is set in
    // the same write that flips it to 'paid' — see updateOrderAfterPayment/
    // handleRazorpayWebhookEvent), but this is the one field the actual
    // Razorpay refund call needs, so it's worth its own clear error rather
    // than a confusing failure from the gateway call below.
    throw new customError('This order has no recorded payment to refund.', 400);
  }
  if (!orderService.CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
    throw new customError(
      `This order can no longer be cancelled and refunded here (status: '${order.status}') — it needs the shipment-level cancellation flow instead.`,
      400
    );
  }

  // Durable proof-of-intent, written before Razorpay is ever called — if
  // the process crashes or loses its DB connection at literally any point
  // from here on, this row (and its `payment_id`) is what lets
  // reconcileUnresolvedRefunds find its way back to this order and ask
  // Razorpay directly what actually happened, rather than depending on
  // Order's own fields having been successfully updated.
  const attempt = await prisma.refundAttempt.create({
    data: {
      orderId,
      paymentId: order.payment_id,
      amount: order.total,
      reason: reason || null,
      requestedBy: adminUserId,
    },
  });

  // A failure here (Razorpay rejects the refund, is unreachable, etc.)
  // must stop before anything about the order changes — the catch below
  // rethrows rather than swallowing, so that guarantee still holds; it
  // exists only to make the failure visible. Confirmed live against
  // Razorpay's real test-mode API: the SDK throws a plain
  // `{ statusCode, error }` object, not an Error instance, so it has no
  // `.message` — left uncaught, errorHandler.js's `err.message ||
  // 'Something went wrong'` fallback always wins and the admin never sees
  // Razorpay's actual reason (e.g. "The id provided does not exist",
  // "refund amount exceeds the payment amount"). Pulling that reason out
  // into a real Error here is what actually surfaces it, matching
  // createRazorpayOrder's own reasoning for wrapping gateway errors.
  let refund;
  try {
    refund = await paymentGateway.refundPayment({
      paymentId: order.payment_id,
      notes: reason ? { reason } : undefined,
    });
  } catch (err) {
    // Best-effort — if even this write fails, the attempt is simply left
    // at 'initiated' with no refundId, which is exactly what it should be:
    // Razorpay itself never accepted anything, so there's nothing for the
    // sweep to reconcile either way.
    await prisma.refundAttempt
      .update({
        where: { id: attempt.id },
        data: { status: 'failed', lastError: err?.error?.description || err?.message || 'Unknown gateway error' },
      })
      .catch(() => {});
    throw new customError(
      err?.error?.description || 'Razorpay was unable to process this refund.',
      400
    );
  }

  // From here on, Razorpay has genuinely accepted (possibly already fully
  // processed) the refund — nothing below may ever throw back to the
  // caller as a failure, because telling an admin "the refund failed"
  // when Razorpay's side says otherwise risks a duplicate real refund
  // attempt. Both writes happen in one retried transaction so the
  // RefundAttempt and Order records can't diverge from each other under a
  // transient write conflict (see withTransactionRetry); if the whole
  // transaction still doesn't land after retrying, the fallback below is
  // what keeps this from becoming exactly the gap this function exists to
  // close.
  const refundIsAlreadyComplete = refund.status === 'processed';
  let updated;
  try {
    const result = await withTransactionRetry(async (tx) => {
      await tx.refundAttempt.update({
        where: { id: attempt.id },
        data: {
          refundId: refund.id,
          status: refundIsAlreadyComplete ? 'completed' : 'pending',
          processedAt: refundIsAlreadyComplete ? new Date() : null,
        },
      });
      return tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'refund_pending' },
      });
    });
    updated = result;
  } catch (err) {
    // The exact "refund has a failure window" scenario: Razorpay's refund
    // is real, but neither of the writes above landed. Logged loudly as a
    // reconciliation-needed event; a best-effort, non-transactional
    // fallback still records the one fact that matters most for
    // reconcileUnresolvedRefunds to find this later — that a real
    // Razorpay refundId now exists for this attempt — even though the
    // order's own paymentStatus is left exactly as it was.
    logger.error(
      `[payment] Refund ${refund.id} succeeded at Razorpay for order ${orderId}, but the local DB write failed — reconciliation sweep will repair this`,
      { orderId, refundId: refund.id, error: err?.message, stack: err?.stack }
    );
    await prisma.refundAttempt
      .update({
        where: { id: attempt.id },
        data: {
          refundId: refund.id,
          status: refundIsAlreadyComplete ? 'completed' : 'pending',
          processedAt: refundIsAlreadyComplete ? new Date() : null,
        },
      })
      .catch((fallbackErr) => {
        logger.error(`[payment] Even the fallback RefundAttempt write failed for order ${orderId}`, {
          orderId,
          refundId: refund.id,
          error: fallbackErr?.message,
        });
      });
    updated = await prisma.order.findUnique({ where: { id: orderId } });
  }

  logger.info(
    `[payment] Refund ${refund.id} initiated for order ${orderId} by admin ${adminUserId}${reason ? `: ${reason}` : ''}`
  );

  return { order: updated, refund };
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
      // Excludes orders that have never actually started a real payment
      // attempt — every order now always has a payment_order_id (see
      // src/constants/payment.js), so `{ not: null }` above alone would
      // otherwise sweep up every ordinary abandoned/untouched cart too and
      // waste a real Razorpay lookup on a placeholder id that was never
      // sent to Razorpay at all.
      NOT: { payment_order_id: { startsWith: PENDING_PAYMENT_ORDER_ID_PREFIX } },
      updatedAt: { lt: staleBefore },
    },
  });

  const results = { timedOut: 0, reconciledPaid: 0, unknown: 0 };

  for (const order of staleOrders) {
    // eslint-disable-next-line no-await-in-loop
    const razorpayOrder = await exports.fetchRazorpayOrder(
      order.payment_order_id
    );

    if (!razorpayOrder) {
      // Couldn't reach Razorpay to confirm one way or the other — don't
      // guess at a real payment's fate.
      // eslint-disable-next-line no-await-in-loop
      await prisma.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
        },
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
        await exports.updateOrderAfterPayment(
          order.payment_order_id,
          captured.id
        );
        results.reconciledPaid += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await prisma.order.updateMany({
          where: {
            id: order.id,
            paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
          },
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
      where: {
        id: order.id,
        paymentStatus: { in: RECONCILABLE_PAYMENT_STATUSES },
      },
      data: { paymentStatus: 'timeout' },
    });
    results.timedOut += 1;
  }

  return results;
};

/**
 * The fulfillment-reconciliation sweep — the actual retry mechanism behind
 * runFulfillment's 'failed' orders (see jobs/index.js, which schedules this
 * on a fixed interval, same pattern as reconcileStalePaymentAttempts
 * above). An order only ever lands here if it's already durably confirmed
 * (a captured payment or a committed COD order) but a fulfillment
 * side-effect — stock decrement, cart clear, or the confirmation
 * notification — failed or was never even attempted (e.g. a Redis outage
 * at the moment runFulfillment tried to enqueue a job); this is what
 * actually gives that a second chance instead of leaving it as a log line
 * an operator would have to notice and fix by hand.
 *
 * Bounded by MAX_FULFILLMENT_ATTEMPTS: an order whose failure can't
 * self-heal by retrying (the "paid but oversold" case above all — there is
 * no amount of retrying that decrements stock that doesn't exist) stops
 * being retried once it hits the cap, rather than being sweept forever,
 * and is left at fulfillmentStatus 'failed' for admin.service.js's
 * getOperationalAlerts to surface to a human.
 */
exports.reconcileFailedFulfillments = async () => {
  const failedOrders = await prisma.order.findMany({
    where: {
      fulfillmentStatus: 'failed',
      fulfillmentAttempts: { lt: MAX_FULFILLMENT_ATTEMPTS },
    },
    include: { orderItems: true },
  });

  const results = { retried: 0, recovered: 0, stillFailing: 0 };

  for (const order of failedOrders) {
    // decrementStock: false for a COD order (its stock was already
    // reserved transactionally in handleCODOrder, never through this
    // path) — belt-and-braces alongside runFulfillment's own
    // `!order.stockDecremented` guard, which is what actually prevents a
    // double-decrement on every path, this included.
    // eslint-disable-next-line no-await-in-loop
    await runFulfillment(order, {
      decrementStock: order.paymentStatus !== 'cod_pending',
    });
    results.retried += 1;

    // eslint-disable-next-line no-await-in-loop
    const after = await prisma.order.findUnique({
      where: { id: order.id },
      select: { fulfillmentStatus: true },
    });
    if (after?.fulfillmentStatus === 'completed') {
      results.recovered += 1;
    } else {
      results.stillFailing += 1;
    }
  }

  return results;
};

// How long a RefundAttempt is left alone before the sweep escalates to
// asking Razorpay directly what happened to it. Not zero — Razorpay's own
// refund.processed/refund.failed webhook is the fast, normal path and
// usually lands within seconds; polling every attempt immediately would
// just be redundant load against Razorpay's API for the overwhelming
// majority that the webhook already resolves fine on its own. This sweep
// exists for the ones that don't — see refundOrderPayment's own comment on
// the "refund has a failure window" gap.
const REFUND_RECONCILIATION_STALENESS_MS =
  Number(process.env.REFUND_RECONCILIATION_STALENESS_MS) || 2 * 60 * 1000;

/**
 * The actual retry/repair mechanism behind a RefundAttempt left 'initiated'
 * or 'pending' longer than a normal webhook delivery should ever take —
 * see refundOrderPayment's own comment on why that row exists at all: a
 * real Razorpay refund can succeed while the local write that was supposed
 * to record it independently fails, leaving Order.paymentStatus stuck at
 * 'paid' with nothing (not even the webhook) able to find its way back to
 * it. This works from RefundAttempt's own `orderId`/`paymentId` instead —
 * durable from the moment refundOrderPayment is first called, regardless
 * of what happened to Order's own fields afterward.
 */
exports.reconcileUnresolvedRefunds = async () => {
  const staleBefore = new Date(Date.now() - REFUND_RECONCILIATION_STALENESS_MS);

  const unresolved = await prisma.refundAttempt.findMany({
    where: {
      status: { in: ['initiated', 'pending'] },
      requestedAt: { lt: staleBefore },
    },
  });

  const results = { checked: 0, completed: 0, failed: 0, stillPending: 0, unknown: 0 };

  for (const attempt of unresolved) {
    results.checked += 1;

    // eslint-disable-next-line no-await-in-loop
    let refund = attempt.refundId
      ? await paymentGateway.fetchRefund(attempt.paymentId, attempt.refundId)
      : null;

    if (!refund && !attempt.refundId) {
      // The rarer double-failure case: refundOrderPayment's own follow-up
      // write never even recorded the refundId Razorpay assigned. This app
      // never issues a second real refund against an order still sitting
      // at 'paid' (refundOrderPayment's own eligibility check prevents
      // it), so there is at most one real result to find this way.
      // eslint-disable-next-line no-await-in-loop
      const found = await paymentGateway.fetchRefundsForPayment(attempt.paymentId);
      refund = found[0] || null;
    }

    if (!refund) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.refundAttempt.update({
        where: { id: attempt.id },
        data: { status: 'unknown' },
      });
      results.unknown += 1;
      continue;
    }

    if (refund.status === 'processed') {
      // eslint-disable-next-line no-await-in-loop
      await withTransactionRetry(async (tx) => {
        await tx.refundAttempt.update({
          where: { id: attempt.id },
          data: { refundId: refund.id, status: 'completed', processedAt: new Date() },
        });
        const orderResult = await tx.order.updateMany({
          where: { id: attempt.orderId, paymentStatus: { in: ['paid', 'refund_pending'] } },
          data: { paymentStatus: 'refunded', status: 'cancelled' },
        });
        if (orderResult.count > 0) {
          const order = await tx.order.findUnique({
            where: { id: attempt.orderId },
            include: { orderItems: true },
          });
          if (order) {
            await inventoryService.restoreStockForOrder(order.orderItems, tx);
          }
        }
      });
      results.completed += 1;
    } else if (refund.status === 'failed') {
      // eslint-disable-next-line no-await-in-loop
      await prisma.order.updateMany({
        where: { id: attempt.orderId, paymentStatus: { in: ['paid', 'refund_pending'] } },
        data: { paymentStatus: 'refund_failed' },
      });
      // eslint-disable-next-line no-await-in-loop
      await prisma.refundAttempt.update({
        where: { id: attempt.id },
        data: { refundId: refund.id, status: 'failed', processedAt: new Date() },
      });
      results.failed += 1;
    } else {
      // Still genuinely in flight on Razorpay's side — leave the order
      // alone; the webhook (or a later sweep pass) will catch it once
      // Razorpay actually resolves it. Records the refundId now if this
      // is the first time it's been discovered, so the next pass can go
      // straight to fetchRefund instead of listing again.
      if (!attempt.refundId) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.refundAttempt.update({
          where: { id: attempt.id },
          data: { refundId: refund.id, status: 'pending' },
        });
      }
      results.stillPending += 1;
    }
  }

  return results;
};
