const redis = require('@config/redis');
const CustomError = require('@utils/customError');
const normalizePhone = require('@utils/formatNumber');

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

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
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

module.exports = otpRateLimiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.otpRateLimiter = otpRateLimiter;
module.exports.otpVerifyRateLimiter = otpVerifyRateLimiter;
module.exports.adminLoginRateLimiter = adminLoginRateLimiter;
