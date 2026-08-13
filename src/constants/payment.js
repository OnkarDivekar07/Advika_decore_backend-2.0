// src/constants/payment.js
//
// Shared payment-lifecycle constants. Currently just the staleness window
// reconcileStalePaymentAttempts (payment.service.js) uses to decide a
// pending/attempted/processing payment attempt has gone stale and should be
// marked 'timeout' — pulled from env (see src/config/env.js) rather than
// hardcoded here, same reasoning as src/constants/pricing.js's delivery
// charge: ops can tune it without a code change.
const env = require('@config/env');

const PAYMENT_ATTEMPT_TIMEOUT_MS = env.paymentAttemptTimeoutMinutes * 60 * 1000;

// States a payment attempt can be reconciled *away from* once it's gone
// stale or been explicitly abandoned — i.e. everything that isn't already a
// terminal outcome (paid/failed/cancelled/timeout/unknown/refunded) or COD's
// own separate cod_pending state.
const RECONCILABLE_PAYMENT_STATUSES = ['pending', 'attempted', 'processing'];

module.exports = {
  PAYMENT_ATTEMPT_TIMEOUT_MS,
  RECONCILABLE_PAYMENT_STATUSES,
};
