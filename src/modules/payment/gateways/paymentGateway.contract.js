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
 *   Webhook (from parseWebhookEvent): { eventType, payment: Payment|null }
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
 * @property {(body: Object) => { eventType: string|null, payment: Object|null }} parseWebhookEvent
 *   Turns a provider's raw (already signature-verified) webhook body into
 *   the normalized { eventType, payment } shape above.
 */

const REQUIRED_METHODS = [
  'createOrder',
  'fetchOrder',
  'fetchOrderPayments',
  'fetchPayment',
  'verifyPaymentSignature',
  'verifyWebhookSignature',
  'parseWebhookEvent',
];

/**
 * Fails fast at startup (see ./index.js) if a registered adapter is missing
 * part of the contract, instead of that surfacing later as a confusing
 * "X is not a function" deep inside a request — a broken adapter should
 * never make it as far as handling real payment traffic.
 */
function assertImplementsContract(gateway) {
  const missing = REQUIRED_METHODS.filter((m) => typeof gateway?.[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `Payment gateway "${gateway?.name ?? 'unknown'}" is missing required method(s): ${missing.join(', ')}`
    );
  }
  if (typeof gateway.name !== 'string' || !gateway.name) {
    throw new Error('Payment gateway adapter must expose a non-empty string `name`.');
  }
}

module.exports = { REQUIRED_METHODS, assertImplementsContract };
