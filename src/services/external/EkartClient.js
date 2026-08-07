// src/services/external/EkartClient.js
// Thin wrapper around Ekart Logistics' B2C shipping API. There's no
// official Node SDK, so this talks to the REST API directly using the
// built-in `fetch` (available on Node 20+, no extra dependency needed).
//
// Get your API key, merchant ID, and exact endpoint paths from your Ekart
// dashboard under Settings > API / Developer, and confirm the paths below
// against that documentation (marked with TODOs) before going live.

const crypto = require('crypto');

const EKART_BASE_URL = process.env.EKART_BASE_URL || 'https://api.ekartlogistics.com';
const EKART_API_KEY = process.env.EKART_API_KEY;
const EKART_MERCHANT_ID = process.env.EKART_MERCHANT_ID;
const EKART_WEBHOOK_SECRET = process.env.EKART_WEBHOOK_SECRET;

async function ekartRequest(path, { method = 'GET', body } = {}) {
  try {
    const response = await fetch(`${EKART_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // TODO: confirm exact auth header name/format against your Ekart
        // API docs — some carrier APIs use "Authorization: Bearer <key>",
        // others a custom header like "X-API-KEY".
        Authorization: `Bearer ${EKART_API_KEY}`,
        'X-Merchant-Id': EKART_MERCHANT_ID,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.message || data?.error || `Ekart API error (${response.status})`;
      const err = new Error(message);
      err.statusCode = response.status;
      err.raw = data;
      throw err;
    }

    return data;
  } catch (error) {
    console.error(`Error calling Ekart API [${method} ${path}]:`, error.message);
    throw error;
  }
}

/**
 * Check pincode serviceability + SLA before creating a shipment.
 * TODO: confirm exact path/payload shape against Ekart's "Serviceability and SLA" doc.
 */
exports.checkServiceability = ({ originPincode, destinationPincode, paymentMode, weightKg }) =>
  ekartRequest('/v1/serviceability', {
    method: 'POST',
    body: {
      pickup_pincode: originPincode,
      delivery_pincode: destinationPincode,
      payment_mode: paymentMode,
      weight: weightKg,
    },
  });

/**
 * Create a shipment (manifest) for an order.
 * TODO: confirm exact path/payload shape against Ekart's "Create Shipment" doc.
 */
exports.createShipment = (payload) =>
  ekartRequest('/v1/shipments', { method: 'POST', body: payload });

/**
 * Track a shipment by tracking ID / AWB number.
 * TODO: confirm exact path against Ekart's "Track Shipment" doc.
 */
exports.trackShipment = (trackingId) => ekartRequest(`/v1/shipments/${trackingId}/track`);

/**
 * Cancel a shipment before it's out for delivery.
 * TODO: confirm exact path against Ekart's "Cancel/RTO" doc.
 */
exports.cancelShipment = (trackingId, reason) =>
  ekartRequest(`/v1/shipments/${trackingId}/cancel`, { method: 'POST', body: { reason } });

/**
 * Update shipment details (e.g. corrected address) before dispatch.
 * TODO: confirm exact path against Ekart's "Update Shipment" doc.
 */
exports.updateShipment = (trackingId, updates) =>
  ekartRequest(`/v1/shipments/${trackingId}`, { method: 'PATCH', body: updates });

/**
 * Verify the signature Ekart sends on webhook calls, so we know a status
 * update actually came from Ekart and not a spoofed request. Same
 * constant-time comparison pattern as payment.service.js's Razorpay checks.
 * TODO: confirm the exact header name and signing scheme against Ekart's
 * webhook docs — this assumes HMAC-SHA256 over the raw body, keyed with
 * EKART_WEBHOOK_SECRET, which is the common pattern but needs verifying.
 */
exports.verifyWebhookSignature = (rawBody, signature) => {
  if (!EKART_WEBHOOK_SECRET) return true; // not configured yet — skip rather than block all webhooks

  const expected = crypto
    .createHmac('sha256', EKART_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(String(signature || ''), 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};
