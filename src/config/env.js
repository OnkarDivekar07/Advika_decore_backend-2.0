// src/config/env.js
const dotenv = require('dotenv');

dotenv.config();

const requiredEnv = [
  'PORT',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'MSG91_AUTH_KEY',
  'MSG91_TEMPLATE_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'BUCKET_NAME',
];

const missing = requiredEnv.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}`
  );
}

// --- Delivery pricing (optional) --------------------------------------------
// Flat delivery-charge rule: free above a threshold, a fixed fee below it.
// Both are optional (not in requiredEnv) — a sane default keeps every
// existing deployment working unchanged if these are never set. Parsed once
// here at boot, not read live per-request from src/constants/pricing.js, so
// a malformed value fails fast at startup rather than silently corrupting
// every order's total computed afterwards.
//
// This is what makes the rule backend-configurable end to end: change these
// two env vars (no code/deploy needed beyond a restart) and both the actual
// charge applied to orders (order.service.js / cart.service.js, via
// src/constants/pricing.js) and what the frontend shows before checkout
// (fetched live from GET /api/shipping/delivery-config — see
// shipping.service.js's getDeliveryConfig) move together automatically.
const DEFAULT_FREE_DELIVERY_THRESHOLD = 600;
const DEFAULT_DELIVERY_CHARGE = 49;

function parseNonNegativeNumber(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: '${raw}' must be a non-negative number`);
  }
  return parsed;
}

const freeDeliveryThreshold = parseNonNegativeNumber(
  process.env.FREE_DELIVERY_THRESHOLD,
  DEFAULT_FREE_DELIVERY_THRESHOLD,
  'FREE_DELIVERY_THRESHOLD'
);
const deliveryCharge = parseNonNegativeNumber(
  process.env.DELIVERY_CHARGE,
  DEFAULT_DELIVERY_CHARGE,
  'DELIVERY_CHARGE'
);

// --- Shipping-check fallback policy (optional) ------------------------------
// What to do when the carrier (Ekart) serviceability check itself fails to
// answer at all — times out, network error, 5xx — at the one call site
// where that answer gates whether an order can actually be placed (see
// shipping.service.js's checkDeliveryEligibility, called from
// order.service.js's detectAddressConflict just before COD confirmation /
// Razorpay order creation). This is deliberately a named, explicit,
// ops-configurable policy rather than a silent hardcoded choice buried in
// application code — a carrier outage having a real, understood business
// consequence either way, not an accidental side effect of how a catch
// block happens to be written.
//
//   'fail_open'   (default) — an unanswered check does NOT block checkout.
//                  Keeps orders flowing through a carrier hiccup, at the
//                  cost of occasionally accepting an order for an address
//                  that turns out to be genuinely unserviceable (caught
//                  later at shipment-creation time instead, per
//                  shipping.service.js's createShipmentForOrder).
//   'fail_closed' — an unanswered check DOES block checkout (a distinct
//                  CHECK_UNAVAILABLE reason, never confused with a real
//                  "not covered" answer — see UNSERVICEABLE_REASON). Zero
//                  risk of accepting an unshippable order, at the cost of
//                  blocking legitimate checkouts for as long as the
//                  carrier integration is down.
// This never affects the *informational* pre-checkout serviceability
// widgets (product page / address form) — those already surface a check
// failure as "couldn't check" rather than a fabricated answer either way
// (see shipping.service.js's checkServiceability, which throws a 503
// instead of ever guessing).
const ALLOWED_SHIPPING_FALLBACK_POLICIES = ['fail_open', 'fail_closed'];
const rawShippingFallbackPolicy = process.env.SHIPPING_SERVICEABILITY_FALLBACK_POLICY;
const shippingServiceabilityFallbackPolicy =
  rawShippingFallbackPolicy === undefined || rawShippingFallbackPolicy === ''
    ? 'fail_open'
    : rawShippingFallbackPolicy;

if (!ALLOWED_SHIPPING_FALLBACK_POLICIES.includes(shippingServiceabilityFallbackPolicy)) {
  throw new Error(
    `Invalid SHIPPING_SERVICEABILITY_FALLBACK_POLICY: '${rawShippingFallbackPolicy}' — must be one of ${ALLOWED_SHIPPING_FALLBACK_POLICIES.join(', ')}`
  );
}

module.exports = {
  port: process.env.PORT,
  dbUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  jwtSecret: process.env.JWT_SECRET,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  msg91AuthKey: process.env.MSG91_AUTH_KEY,
  msg91TemplateId: process.env.MSG91_TEMPLATE_ID,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  bucketName: process.env.BUCKET_NAME,
  nodeEnv: process.env.NODE_ENV || 'development',
  freeDeliveryThreshold,
  deliveryCharge,
  shippingServiceabilityFallbackPolicy,
  // Add more as needed
};
