const redis = require('@config/redis');
const CustomError = require('@utils/customError');

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
}) => {
  return async (req, res, next) => {
    const phone = req.body.phone;
    const key = `${prefix}:${phone}`;

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    if (count > maxAttempts) {
      return next(new CustomError(message, 429));
    }

    next();
  };
};

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
