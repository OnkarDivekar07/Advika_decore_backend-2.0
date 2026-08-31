// src/services/external/DelhiveryClient.js
// Thin wrapper around Delhivery's B2C shipping API (no official Node SDK,
// so this talks to the REST API directly using the built-in `fetch`,
// available on Node 20+). Replaces the never-finished Ekart integration —
// nothing here was previously verified against a real courier account
// either, so this is a first real implementation, not a working
// integration being swapped out.
//
// Delhivery's API has a few well-documented quirks worth knowing before
// touching this file — all confirmed by actually creating, tracking, and
// cancelling a real test shipment against a real account (not just
// assumed from documentation, the same standard the R2 migration was held
// to):
//   - Auth is `Authorization: Token <api_token>` — the literal word
//     "Token", not "Bearer".
//   - `/api/cmu/create.json` (create shipment) takes a FORM-ENCODED body
//     with a single `format=json&data=<JSON string>` pair, not a raw JSON
//     request body.
//   - `/api/p/edit` (cancel/update) is different: it wants the fields as
//     PLAIN form fields directly (no `data=` JSON wrapper), and — without
//     an `Accept: application/json` header — replies with an XML body
//     instead of JSON even though the rest of the API is JSON. Both
//     endpoints need that header; only /edit's behavior actually changes
//     without it.
//   - `weight` in the create-shipment payload is expected in GRAMS, not
//     kilograms — a commonly-cited gotcha in Delhivery integrations.
// The status vocabulary in shipping.service.js's RAW_TO_SHIPMENT_STATUS
// was a documented-but-unverified guess and turned out correct on the
// first live shipment ("Manifested" came back exactly as mapped) — still
// worth re-confirming as more real statuses (In Transit, Delivered, RTO,
// ...) are actually seen in production, since only one status has been
// observed live so far.

const crypto = require('crypto');
const logger = require('@config/logger');

const DELHIVERY_BASE_URL =
  process.env.DELHIVERY_BASE_URL || 'https://track.delhivery.com';
const DELHIVERY_API_TOKEN = process.env.DELHIVERY_API_TOKEN;
const DELHIVERY_WEBHOOK_SECRET = process.env.DELHIVERY_WEBHOOK_SECRET;

// Serviceability checks can now sit in a hard checkout path (see
// order.service.js's detectAddressConflict), not just the informational
// pincode widgets — so a hung Delhivery call needs a ceiling rather than
// being able to stall a COD confirmation / Razorpay order creation
// indefinitely. Kept generous (checkout is already a multi-step flow) but
// finite.
const DELHIVERY_REQUEST_TIMEOUT_MS =
  Number(process.env.DELHIVERY_REQUEST_TIMEOUT_MS) || 8000;

async function delhiveryRequest(
  path,
  { method = 'GET', body, formEncoded = false } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DELHIVERY_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${DELHIVERY_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': formEncoded
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
        // Required for a JSON response from /api/p/edit specifically (it
        // otherwise replies with XML) — confirmed live; harmless on every
        // other endpoint, which already replies with JSON regardless.
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_API_TOKEN}`,
      },
      body,
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.rmk ||
        data?.error ||
        data?.message ||
        `Delhivery API error (${response.status})`;
      const err = new Error(message);
      err.statusCode = response.status;
      err.raw = data;
      throw err;
    }

    return data;
  } catch (error) {
    // A timeout/abort has no statusCode of its own — flag it explicitly so
    // callers (shipping.service.js) can tell "Delhivery never answered"
    // apart from "Delhivery answered with an error", without inspecting
    // error.name.
    if (error.name === 'AbortError') {
      error.isTimeout = true;
      error.message = `Delhivery API request timed out after ${DELHIVERY_REQUEST_TIMEOUT_MS}ms`;
    }
    logger.error(
      `Error calling Delhivery API [${method} ${path}]: ${error.message}`
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check whether Delhivery services a destination pincode at all, and
 * whether COD is available there. Delhivery's pincode-serviceability
 * endpoint is a pure lookup — it doesn't take an origin pincode, weight,
 * or payment mode as input, and doesn't return an SLA day-count the way
 * the previous (unverified) Ekart assumption did; shipping.service.js
 * treats a missing estimate as "unknown" rather than fabricating one.
 */
exports.checkServiceability = async ({ destinationPincode }) => {
  const data = await delhiveryRequest(
    `/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(destinationPincode)}`
  );
  const entry = data?.delivery_codes?.[0]?.postal_code;
  if (!entry) {
    // Empty delivery_codes means Delhivery doesn't recognize this pincode
    // at all — distinct from "recognized but not covered", which would
    // still return an entry (with delivery flags reflecting that).
    return { serviceable: false, recognized: false, codAvailable: false };
  }
  return {
    serviceable: true,
    recognized: true,
    codAvailable: entry.cod === 'Y',
    prepaidAvailable: entry.pre_paid === 'Y',
  };
};

/**
 * Create a shipment (waybill) for an order. Delhivery's "Cash Memo
 * Upload" (cmu) endpoint — form-encoded body, one shipment per call here
 * (the API supports batching, not needed for this app's one-order-at-a-
 * time flow).
 */
exports.createShipment = (payload) => {
  const shipmentPayload = {
    shipments: [
      {
        name: payload.consignee.name,
        add: payload.consignee.address,
        pin: payload.consignee.pincode,
        city: payload.consignee.city,
        state: payload.consignee.state,
        country: 'India',
        phone: payload.consignee.phone,
        order: payload.order_id,
        payment_mode: payload.payment_mode === 'COD' ? 'COD' : 'Prepaid',
        cod_amount: payload.cod_amount || 0,
        products_desc: payload.products_desc || 'General merchandise',
        quantity: payload.quantity,
        total_amount: payload.total_amount,
        seller_name: payload.seller_name || undefined,
        // Grams, not kilograms — see file header note.
        weight: Math.round((payload.weight_kg || 0) * 1000),
        shipping_mode: 'Surface',
        address_type: 'home',
      },
    ],
    pickup_location: { name: payload.pickup_location_name },
  };

  const body = new URLSearchParams({
    format: 'json',
    data: JSON.stringify(shipmentPayload),
  }).toString();

  return delhiveryRequest('/api/cmu/create.json', {
    method: 'POST',
    body,
    formEncoded: true,
  });
};

/**
 * Track a shipment by its waybill (AWB) number.
 */
exports.trackShipment = (waybill) =>
  delhiveryRequest(
    `/api/v1/packages/json/?waybill=${encodeURIComponent(waybill)}&verbose=2`
  );

/**
 * Cancel a shipment before it's out for delivery. Delhivery's "edit"
 * endpoint doubles as the cancellation call — unlike createShipment, this
 * one takes plain form fields directly (no `data=` JSON wrapper).
 * Resolves to `{ status: true/false, waybill, order_id, remark }` — a
 * `false` status (e.g. cancelling an already-cancelled shipment) is a
 * normal, non-throwing outcome callers should check for, not an error.
 */
exports.cancelShipment = (waybill) => {
  const body = new URLSearchParams({ waybill, cancellation: 'true' }).toString();

  return delhiveryRequest('/api/p/edit', {
    method: 'POST',
    body,
    formEncoded: true,
  });
};

/**
 * Update shipment details (e.g. corrected address) before dispatch, via
 * the same "edit" endpoint cancellation uses, without the cancellation
 * flag — same plain-form-fields shape as cancelShipment.
 */
exports.updateShipment = (waybill, updates) => {
  const body = new URLSearchParams({ waybill, ...updates }).toString();

  return delhiveryRequest('/api/p/edit', {
    method: 'POST',
    body,
    formEncoded: true,
  });
};

/**
 * Verify the signature Delhivery sends on webhook calls, so we know a
 * status update actually came from Delhivery and not a spoofed request.
 * Same constant-time comparison pattern as payment.service.js's Razorpay
 * checks.
 *
 * Unlike Razorpay's, Delhivery doesn't publish one universal, self-serve
 * webhook signing scheme — webhook delivery is typically set up per
 * account with their integration team, and the exact header name/signing
 * algorithm should be confirmed with them once webhooks are actually
 * configured. This assumes the common HMAC-SHA256-over-raw-body pattern
 * used elsewhere in this codebase until that's confirmed. In the
 * meantime, shipment status still stays accurate without a working
 * webhook at all — trackOrderShipment polls Delhivery live on every
 * GET /track call, which is this app's actual source of truth.
 */
exports.verifyWebhookSignature = (rawBody, signature) => {
  // Fail CLOSED, not open, when unconfigured — unlike SMS/notification
  // integrations elsewhere in this codebase, where "not configured yet"
  // safely means "no-op, skip the send", an unconfigured secret here
  // would otherwise mean "trust every unsigned request." Anyone who can
  // guess/observe a waybill could forge shipment/order status updates
  // (e.g. a fake DELIVERED) with zero authentication.
  if (!DELHIVERY_WEBHOOK_SECRET) {
    logger.error(
      'DELHIVERY_WEBHOOK_SECRET is not set — rejecting Delhivery webhook request rather than trusting it unsigned. Set DELHIVERY_WEBHOOK_SECRET before going live with webhook delivery.'
    );
    return false;
  }

  const expected = crypto
    .createHmac('sha256', DELHIVERY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(String(signature || ''), 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};
