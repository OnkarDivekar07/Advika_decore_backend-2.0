// src/utils/withTimeout.js
//
// Races a promise against a local timeout, rejecting if the promise hasn't
// settled in time. Originally written inline in src/routes/health.js for
// exactly one case (an unreachable MongoDB otherwise inheriting Prisma's
// 30s serverSelectionTimeoutMS default — see that file's own history).
// Pattern 18 (error handling/resilience audit) found the identical failure
// shape at two more real call sites: rateLimiter.js and
// paginateWithCache.js both call directly into Redis with no timeout of
// their own — confirmed live, a genuinely unreachable Redis (not just
// slow) made requests to OTP send/verify, admin login, and any cached
// listing endpoint hang indefinitely instead of failing cleanly, because
// @config/redis.js's shared ioredis client is intentionally configured
// with `maxRetriesPerRequest: null` (correct for BullMQ's blocking
// connections, wrong for a direct ad-hoc command that a live HTTP request
// is waiting on). Extracted here so every direct-Redis call site can share
// the same fix instead of re-solving it inline three separate times.
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Don't let this timer alone keep the process (or a test runner) alive
    // if it's still pending when everything else has settled/exited.
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = withTimeout;
