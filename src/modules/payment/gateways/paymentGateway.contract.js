/**
 * Contract every payment gateway adapter (./razorpay.gateway.js and any
 * future one, e.g. ./stripe.gateway.js) must implement.
 *
 * payment.service.js and payment.controller.js talk to whatever ./index.js
 * resolves ONLY through these methods and these normalized shapes — neither
 * file should ever `require` a gateway SDK, build an HMAC signature itself,
 * or reach into a gateway's raw request/response/webhook shape directly.
 * Adding a new provider means writing a new file here that implements this
 * contract and registering it in ./index.js — not touching
 * payment.service.js or payment.controller.js.
 *
 * Normalized shapes returned by adapters (deliberately close to what this
 * app's existing code already expected, since Razorpay was — and today
 * still is — the only integration; a new adapter's job is to map its own
 * provider's field names into these, not the other way round):
 *
 *   Order:   { id, amount, currency, status, raw }
 *   Payment: { id, order_id, status, amount, raw }
 *     - `order_id` is deliberately snake_case — it mirrors this app's own
 *       Order.payment_order_id and every existing call site in
 *       payment.service.js/payment.controller.js that reads it.
 *   Refund:  { id, payment_id, status, amount, raw }
 *   Webhook (from parseWebhookEvent): { eventType, payment: Payment|null, refund: Refund|null }
 *
 * `raw` is always the untouched provider response, kept only for
 * logging/debugging — callers should never need to read fields off it;
 * doing so would reintroduce the exact coupling this contract exists to
 * prevent.
 *
 * @typedef {Object} PaymentGateway
 * @property {string} name - short id, e.g. 'razorpay'. Used as
 *   WebhookEvent.source (see payment.service.js's handleRazorpayWebhookEvent)
 *   and for logging.
 * @property {Object} publicConfig - opaque config handed straight through
 *   to the frontend in createOrderid's response (today: `{ key_id }`,
 *   matching what Razorpay Checkout.js expects — see payment.controller.js).
 *   Callers should treat this as an opaque pass-through, not something to
 *   read fields off of.
 * @property {(args: { amount: number, currency: string, receipt: string }) => Promise<Object>} createOrder
 *   Throws on failure — callers are expected to wrap this themselves (see
 *   payment.service.js's createRazorpayOrder).
 * @property {(orderId: string) => Promise<Object|null>} fetchOrder
 *   Never throws; resolves null on any failure (unrecognized id, network
 *   error) so callers can fall through instead of special-casing it.
 * @property {(orderId: string) => Promise<Array<Object>>} fetchOrderPayments
 *   Never throws; resolves [] on any failure, same reasoning as fetchOrder.
 * @property {(paymentId: string) => Promise<Object|null>} fetchPayment
 *   Never throws; resolves null on any failure, same reasoning as fetchOrder.
 * @property {(args: { orderId: string, paymentId: string, signature: string }) => boolean} verifyPaymentSignature
 *   Constant-time comparison expected internally — this proves an
 *   order/payment id pair was actually signed by the gateway.
 * @property {(rawBody: Buffer, signature: string) => boolean} verifyWebhookSignature
 *   Same constant-time expectation, over the exact raw request bytes.
 * @property {(body: Object) => { eventType: string|null, payment: Object|null, refund: Object|null }} parseWebhookEvent
 *   Turns a provider's raw (already signature-verified) webhook body into
 *   the normalized { eventType, payment, refund } shape above. `refund` is
 *   only ever non-null for the provider's refund-lifecycle events (e.g.
 *   Razorpay's `refund.processed`/`refund.failed`) — every other event
 *   type leaves it null, same as `payment` does for non-payment events.
 * @property {(args: { paymentId: string, amount?: number, notes?: Object }) => Promise<Object>} refundPayment
 *   Initiates a refund against a captured payment — omit `amount` for a
 *   full refund (the common case; this app only ever refunds a whole
 *   order, never a partial line-item amount). Throws on failure — callers
 *   are expected to wrap this themselves (see payment.service.js's
 *   refundOrderPayment). Resolving successfully only means the refund was
 *   *initiated*; refunds are asynchronous on Razorpay's side, so the
 *   authoritative "did it actually complete" answer is the
 *   `refund.processed`/`refund.failed` webhook, not this call's response
 *   — see prisma/schema.prisma's PaymentStatus.refund_pending comment.
 * @property {(paymentId: string, refundId: string) => Promise<Object|null>} fetchRefund
 *   Never throws; resolves null on any failure (unrecognized id, network
 *   error), same reasoning as fetchOrder/fetchPayment. Used only by
 *   reconcileUnresolvedRefunds (payment.service.js) — the direct-poll
 *   backstop for a refund whose outcome the webhook never got to record
 *   locally (see prisma/schema.prisma's RefundAttempt model for why that
 *   gap exists and what this closes).
 * @property {(paymentId: string) => Promise<Array<Object>>} fetchRefundsForPayment
 *   Never throws; resolves [] on any failure. Only used by
 *   reconcileUnresolvedRefunds for the rarer case where even the real
 *   Razorpay refundId never made it into a RefundAttempt row (a second,
 *   independent write failure right after the first) — this app never
 *   issues a second real refund against an order still sitting at 'paid',
 *   so there is at most one real result to find this way.
 */

const REQUIRED_METHODS = [
  'createOrder',
  'fetchOrder',
  'fetchOrderPayments',
  'fetchPayment',
  'verifyPaymentSignature',
  'verifyWebhookSignature',
  'parseWebhookEvent',
  'refundPayment',
  'fetchRefund',
  'fetchRefundsForPayment',
];

/**
 * Fails fast at startup (see ./index.js) if a registered adapter is missing
 * part of the contract, instead of that surfacing later as a confusing
 * "X is not a function" deep inside a request — a broken adapter should
 * never make it as far as handling real payment traffic.
 */
function assertImplementsContract(gateway) {
  const missing = REQUIRED_METHODS.filter(
    (m) => typeof gateway?.[m] !== 'function'
  );
  if (missing.length > 0) {
    throw new Error(
      `Payment gateway "${gateway?.name ?? 'unknown'}" is missing required method(s): ${missing.join(', ')}`
    );
  }
  if (typeof gateway.name !== 'string' || !gateway.name) {
    throw new Error(
      'Payment gateway adapter must expose a non-empty string `name`.'
    );
  }
}

module.exports = { REQUIRED_METHODS, assertImplementsContract };
