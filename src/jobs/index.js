// src/jobs/index.js
const logger = require('@config/logger');

const imageWorker = require('./workers/imageWorker');
const clearCartWorker = require('./workers/clearCartWorker');
const notificationWorker = require('./workers/notificationWorker');
const paymentReconciliationWorker = require('./workers/paymentReconciliationWorker');
const fulfillmentReconciliationWorker = require('./workers/fulfillmentReconciliationWorker');
const refundReconciliationWorker = require('./workers/refundReconciliationWorker');
const imageQueue = require('./queues/imageQueue');
const clearCartQueue = require('./queues/clearCartQueue');
const notificationQueue = require('./queues/notificationQueue');
const paymentReconciliationQueue = require('./queues/paymentReconciliationQueue');
const fulfillmentReconciliationQueue = require('./queues/fulfillmentReconciliationQueue');
const refundReconciliationQueue = require('./queues/refundReconciliationQueue');

const workers = [
  imageWorker,
  clearCartWorker,
  notificationWorker,
  paymentReconciliationWorker,
  fulfillmentReconciliationWorker,
  refundReconciliationWorker,
];
const queues = [
  imageQueue,
  clearCartQueue,
  notificationQueue,
  paymentReconciliationQueue,
  fulfillmentReconciliationQueue,
  refundReconciliationQueue,
];

// How often the stale-payment-attempt sweep (paymentReconciliationWorker)
// runs. Independent of PAYMENT_ATTEMPT_TIMEOUT_MINUTES (src/config/env.js,
// which controls how old an attempt has to be before this sweep is willing
// to close it out) — this is just the polling interval.
const PAYMENT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

// How often the failed-fulfillment sweep (fulfillmentReconciliationWorker)
// runs. Shorter than the payment sweep above — a fulfillment failure means
// an order the customer already paid for may be missing its stock
// decrement/cart-clear/confirmation, so it's worth retrying sooner than a
// still-in-flight payment attempt is worth timing out. Env-overridable
// (unlike PAYMENT_RECONCILIATION_INTERVAL_MS above) so the real E2E
// recovery test can wait seconds instead of minutes for a real sweep cycle
// to fire — see .env.e2e's own value and
// tests/e2e-helpers/fulfillmentSweepRecovery.js (`npm run
// e2e:test:fulfillment-sweep`).
const FULFILLMENT_RECONCILIATION_INTERVAL_MS =
  Number(process.env.FULFILLMENT_RECONCILIATION_INTERVAL_MS) || 2 * 60 * 1000;

// How often the unresolved-refund sweep (refundReconciliationWorker) runs.
// Money-related, so on the shorter end like the fulfillment sweep above —
// see refundOrderPayment's own comment on the "refund has a failure
// window" gap this exists to close. Env-overridable for the same reason
// FULFILLMENT_RECONCILIATION_INTERVAL_MS is.
const REFUND_RECONCILIATION_INTERVAL_MS =
  Number(process.env.REFUND_RECONCILIATION_INTERVAL_MS) || 2 * 60 * 1000;

// Registers one repeatable sweep, logging (not throwing) if it fails —
// discovered live, the hard way: every one of these `.add()` calls used to
// be fire-and-forget with no `await` and no `.catch()` anywhere, including
// at this function's own call site in app.js (`initJobs();`, not awaited).
// A rejected promise nobody was listening to meant a sweep could silently
// never actually get scheduled — confirmed directly: not one of the three
// sweeps below had a real repeatable job registered in Redis
// (queue.getRepeatableJobs()) despite every server start apparently
// succeeding and logging "Workers initialized". That's the exact
// "reconciliation sweep" every one of this session's own review-finding
// fixes (fulfillment, refund) depends on to actually run in production —
// silently never firing would have made all of them dead code. Awaiting
// each one here, with its own try/catch, is what makes a real failure
// (Redis unreachable at boot, a bad connection string) show up in the
// logs instead of vanishing.
async function registerSweep(name, queue, everyMs) {
  try {
    // BullMQ dedupes repeatable jobs by their key (job name + repeat
    // options), so calling this again on a redeploy doesn't stack up
    // duplicate schedules — it's a no-op against the one already
    // registered.
    await queue.add(
      'sweep',
      {},
      {
        repeat: { every: everyMs },
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  } catch (err) {
    logger.error(`Failed to register the ${name} sweep — it will not run until this is fixed`, {
      error: err?.message,
      stack: err?.stack,
    });
  }
}

module.exports = async () => {
  await Promise.all([
    registerSweep('payment-reconciliation', paymentReconciliationQueue, PAYMENT_RECONCILIATION_INTERVAL_MS),
    registerSweep('fulfillment-reconciliation', fulfillmentReconciliationQueue, FULFILLMENT_RECONCILIATION_INTERVAL_MS),
    registerSweep('refund-reconciliation', refundReconciliationQueue, REFUND_RECONCILIATION_INTERVAL_MS),
  ]);

  logger.info('Workers initialized');
  // other workers can be initialized here
};

// Closes queues then workers so deploys/restarts don't drop in-flight jobs:
// - queue.close() stops accepting new jobs from producers.
// - worker.close() waits for any job currently being processed to finish
//   (BullMQ's default grace period) before it stops, rather than killing it
//   mid-run.
// Called from server.js during the SIGTERM handler, before the shared Redis
// connection is torn down.
module.exports.shutdown = async () => {
  await Promise.all(queues.map((queue) => queue.close()));
  await Promise.all(workers.map((worker) => worker.close()));
  logger.info('Workers shut down');
};
