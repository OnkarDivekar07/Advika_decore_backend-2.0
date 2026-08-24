// tests/e2e-helpers/signRazorpayWebhook.js
//
// Builds a validly-HMAC-signed Razorpay webhook request body, for the real
// E2E "online payment" test (frontend-improved/e2e-real/payment-razorpay.spec.js).
//
// Why this exists: Razorpay's real checkout.js widget runs inside an
// external iframe with a real-card/test-card OTP flow that cannot be
// reliably driven by Playwright (confirmed with the user — see the task's
// own rule that mocking only the *external* payment provider boundary is
// acceptable, never the app's own backend). So the real E2E payment test:
//   1. Has the browser trigger the REAL POST /api/payment/create-orderid,
//      which makes a REAL server-to-server call to Razorpay's test-mode
//      REST API and returns a real order_xxx id.
//   2. Uses this helper to build a webhook payload the real backend cannot
//      distinguish from a genuine Razorpay delivery (same HMAC-SHA256
//      algorithm, over the same raw-body bytes, with the same
//      RAZORPAY_WEBHOOK_SECRET the real payment.controller.js verifies
//      against — see src/modules/payment/gateways/razorpay.gateway.js's
//      verifyWebhookSignature/parseWebhookEvent).
//   3. POSTs it to the REAL /api/payment/webhook endpoint, which runs 100%
//      real signature verification + handleRazorpayWebhookEvent logic
//      against the real database.
//
// Only the Razorpay-hosted checkout widget itself is not driven by a real
// browser interaction — every line of the app's own payment code, and the
// real Razorpay REST API for order creation, genuinely runs.
const crypto = require('crypto');

/**
 * @param {object} params
 * @param {string} params.webhookSecret - must equal RAZORPAY_WEBHOOK_SECRET
 *   in the backend process under test (.env.e2e).
 * @param {string} params.razorpayOrderId - a real order_xxx id returned by
 *   a real POST /api/payment/create-orderid call.
 * @param {number} params.amountPaise - order total in paise (integer).
 * @param {'payment.captured'|'payment.failed'|'payment.authorized'} [params.event]
 * @returns {{ rawBody: string, signature: string, headers: Record<string,string>, eventId: string }}
 */
function buildSignedRazorpayWebhook({
  webhookSecret,
  razorpayOrderId,
  amountPaise,
  event = 'payment.captured',
}) {
  const eventId = `evt_e2e_${crypto.randomBytes(8).toString('hex')}`;
  const paymentId = `pay_e2e_${crypto.randomBytes(8).toString('hex')}`;

  const body = {
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          status: event === 'payment.failed' ? 'failed' : 'captured',
          amount: amountPaise,
        },
      },
    },
  };

  // Signed over the exact raw JSON string — payment.controller.js verifies
  // against req.rawBody (the exact bytes received), not a re-stringified
  // object, so the string built here must be the same string sent as the
  // request body (no re-serialization in between).
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return {
    rawBody,
    signature,
    eventId,
    paymentId,
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
  };
}

module.exports = { buildSignedRazorpayWebhook };
