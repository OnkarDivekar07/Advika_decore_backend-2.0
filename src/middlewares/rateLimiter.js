const redis = require('@config/redis');
const CustomError = require('@utils/customError');
const normalizePhone = require('@utils/formatNumber');
const withTimeout = require('@utils/withTimeout');
const logger = require('@config/logger');

// Pattern 18 (error handling/resilience audit): @config/redis.js's shared
// client is deliberately configured with `maxRetriesPerRequest: null` —
// correct for BullMQ's blocking connections, but it means a direct command
// like the incr/expire below queues forever and never rejects while Redis
// is unreachable, rather than failing fast. Confirmed live: a genuinely
// down Redis (not just slow) made every OTP-send/verify and admin-login
// request hang indefinitely with no response at all, not even an
// eventual 500 — the request just never completed. Bounded here so a
// Redis outage fails fast and observably instead.
const REDIS_CHECK_TIMEOUT_MS = 2000;

/**
 * Factory for phone-keyed rate limiters. Each call site gets its own
 * Redis key namespace (via `prefix`) so, e.g., send-otp and verify-otp
 * attempts are tracked independently.
 *
 * @param {Object} opts
 * @param {string} opts.prefix - Redis key namespace, e.g. 'otp-send-limit'
 * @param {number} [opts.maxAttempts=5] - Attempts allowed within the window
 * @param {number} [opts.windowSeconds=60] - Sliding window length in seconds
 * @param {string} [opts.message] - Error message returned once the limit is hit
 */
const createRateLimiter = ({
  prefix,
  maxAttempts = 5,
  windowSeconds = 60,
  message = 'Too many requests. Please try again later.',
  // Optional (req) => string. Lets call sites key the limiter on something
  // other than req.body.phone (e.g. admin login keys on email) without
  // touching the phone-keying default every existing caller relies on.
  // When omitted, behavior is byte-for-byte identical to before this
  // option existed.
  keyBy,
}) => {
  return async (req, res, next) => {
    // This middleware runs *before* validateSendOtp/validateVerifyOtp, so
    // req.body.phone hasn't been trimmed/format-checked yet. Keying
    // directly on the raw string lets the same underlying number dodge
    // the limit just by varying formatting the OTP validators still
    // accept — "+919999999999" vs "+91 9999999999" (verify allows an
    // optional space), or incidental leading/trailing whitespace (send's
    // own .trim() sanitizer hasn't run yet either) — each variant gets
    // its own bucket, multiplying the effective attempt budget on a
    // brute-force-sensitive endpoint. normalizePhone() collapses every
    // representation of the same number down to the same bare 10 digits
    // this app stores/looks users up by, so the limit is actually per
    // phone number rather than per exact string.
    const rawKey = keyBy
      ? keyBy(req)
      : normalizePhone(String(req.body.phone || ''));
    const key = `${prefix}:${rawKey || 'invalid'}`;

    let count;
    try {
      count = await withTimeout(
        redis.incr(key),
        REDIS_CHECK_TIMEOUT_MS,
        `rate limit check (${prefix})`
      );
      // Deliberately inside the same try/catch as incr, not a fire-and-forget
      // best-effort — if this fails/times out, the key keeps counting with
      // no TTL and would silently rate-limit this key forever instead of
      // resetting after windowSeconds. Safer to fail this one request than
      // risk permanently locking out a legitimate phone/email/user.
      if (count === 1) {
        await withTimeout(
          redis.expire(key, windowSeconds),
          REDIS_CHECK_TIMEOUT_MS,
          `rate limit expiry (${prefix})`
        );
      }
    } catch (err) {
      // Fails closed, not open: per this pattern's own instruction not to
      // convert an infrastructure error into a successful response, a
      // broken rate limiter must not silently let every request through
      // unprotected on a brute-force/cost-sensitive endpoint (OTP send,
      // login, payment-order creation). The honest answer when the safety
      // control itself can't be evaluated is "try again shortly," not
      // "sure, go ahead."
      logger.error(
        `Rate limiter (${prefix}) could not reach Redis: ${err.message}`,
        { prefix, key }
      );
      return next(
        new CustomError(
          'Service temporarily unavailable. Please try again in a moment.',
          503
        )
      );
    }

    if (count > maxAttempts) {
      return next(new CustomError(message, 429));
    }

    next();
  };
};

// Throttles POST /api/admin/login attempts, keyed per-email (lowercased +
// trimmed, so "Admin@x.com " and "admin@x.com" share a bucket) rather than
// per-phone — admin login has no phone field. 10 attempts / 5 minutes is
// generous enough not to lock out a genuine admin fumbling their password
// a couple of times, while still making credential-stuffing against a
// known admin email impractical. Missing/malformed email bodies (already
// invalid — validateAdminLogin will 422 them anyway) share an 'invalid'
// bucket rather than bypassing the limiter entirely.
const adminLoginRateLimiter = createRateLimiter({
  prefix: 'admin-login-limit',
  maxAttempts: 10,
  windowSeconds: 300,
  message: 'Too many login attempts. Please try again later.',
  keyBy: (req) =>
    String(req.body?.email || '')
      .trim()
      .toLowerCase(),
});

// Existing default export kept for backwards compatibility — used for
// throttling OTP *send* requests (prevents SMS spam / cost abuse).
const otpRateLimiter = createRateLimiter({
  prefix: 'otp-send-limit',
  maxAttempts: 5,
  windowSeconds: 60,
  message: 'Too many OTP requests. Please try again later.',
});

// Throttles OTP *verify* attempts so a sent OTP can't be brute-forced.
// A 6-digit code has 1,000,000 combinations; capping attempts per phone
// makes brute-forcing it within the 5-minute OTP TTL impractical.
const otpVerifyRateLimiter = createRateLimiter({
  prefix: 'otp-verify-limit',
  maxAttempts: 5,
  windowSeconds: 300, // matches the OTP's own 5-minute expiry
  message: 'Too many OTP verification attempts. Please request a new OTP.',
});

// Pattern 17 (API abuse/validation audit): POST /api/payment/create-orderid
// was the only sensitive, auth-gated endpoint with zero rate limiting —
// unlike OTP send/verify and admin login above, nothing stopped a single
// authenticated account from hammering it. createOrderid's own
// reuse-or-reconcile logic (payment.controller.js) already avoids minting a
// *new* Razorpay order on every repeated call once one exists, but it still
// makes a real GET to Razorpay's API on each one — a sustained loop from one
// account could still exhaust that account's real request budget against
// Razorpay and degrade checkout for everyone else sharing the same API key.
// Keyed per-user (this route requires `authenticate`, so `req.user.userId`
// is always populated) rather than per-phone. 10 attempts / 5 minutes
// mirrors adminLoginRateLimiter's budget — generous enough for a customer
// retrying a flaky connection or double-tapping Pay, tight enough to make
// sustained hammering impractical.
const paymentCreateOrderRateLimiter = createRateLimiter({
  prefix: 'payment-create-order-limit',
  maxAttempts: 10,
  windowSeconds: 300,
  message: 'Too many payment requests. Please try again in a few minutes.',
  keyBy: (req) => req.user?.userId,
});

module.exports = otpRateLimiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.otpRateLimiter = otpRateLimiter;
module.exports.otpVerifyRateLimiter = otpVerifyRateLimiter;
module.exports.adminLoginRateLimiter = adminLoginRateLimiter;
module.exports.paymentCreateOrderRateLimiter = paymentCreateOrderRateLimiter;
