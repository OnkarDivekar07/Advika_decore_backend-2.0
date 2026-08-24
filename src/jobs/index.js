// src/jobs/index.js
const logger = require('@config/logger');

const imageWorker = require('./workers/imageWorker');
const clearCartWorker = require('./workers/clearCartWorker');
const notificationWorker = require('./workers/notificationWorker');
const paymentReconciliationWorker = require('./workers/paymentReconciliationWorker');
const imageQueue = require('./queues/imageQueue');
const clearCartQueue = require('./queues/clearCartQueue');
const notificationQueue = require('./queues/notificationQueue');
const paymentReconciliationQueue = require('./queues/paymentReconciliationQueue');

const workers = [
  imageWorker,
  clearCartWorker,
  notificationWorker,
  paymentReconciliationWorker,
];
const queues = [
  imageQueue,
  clearCartQueue,
  notificationQueue,
  paymentReconciliationQueue,
];

// How often the stale-payment-attempt sweep (paymentReconciliationWorker)
// runs. Independent of PAYMENT_ATTEMPT_TIMEOUT_MINUTES (src/config/env.js,
// which controls how old an attempt has to be before this sweep is willing
// to close it out) — this is just the polling interval.
const PAYMENT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

module.exports = () => {
  // BullMQ dedupes repeatable jobs by their key (job name + repeat options),
  // so calling this again on a redeploy doesn't stack up duplicate
  // schedules — it's a no-op against the one already registered.
  paymentReconciliationQueue.add(
    'sweep',
    {},
    {
      repeat: { every: PAYMENT_RECONCILIATION_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: true,
    }
  );

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
