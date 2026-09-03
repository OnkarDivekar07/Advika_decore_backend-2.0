// src/jobs/workers/fulfillmentReconciliationWorker.js
//
// Processes the repeating 'sweep' job (see jobs/index.js, which schedules
// it on a fixed interval) that calls payment.service.js's
// reconcileFailedFulfillments — the actual retry mechanism behind a
// paid/COD order whose post-confirmation fulfillment (stock decrement,
// cart clear, confirmation notification) failed or never even ran (e.g. a
// Redis outage at the exact moment runFulfillment tried to enqueue a job).
// Without this, that failure only ever existed as a log line with nothing
// automatically retrying it — see the "paid-order fulfillment can fail
// permanently" review finding this closes.
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const logger = require('@config/logger');
const paymentService = require('@modules/payment/payment.service');

const fulfillmentReconciliationWorker = new Worker(
  'fulfillment-reconciliation-queue',
  async () => {
    const results = await paymentService.reconcileFailedFulfillments();
    if (results.retried > 0) {
      logger.info('Fulfillment reconciliation swept failed orders', results);
    }
    return results;
  },
  { connection }
);

fulfillmentReconciliationWorker.on('failed', (job, err) => {
  logger.error(
    `Fulfillment reconciliation sweep failed [${job.id}]: ${err.message}`,
    { stack: err.stack }
  );
});

fulfillmentReconciliationWorker.on('error', (err) => {
  logger.error(`Worker-level error: ${err.message}`, { stack: err.stack });
});

module.exports = fulfillmentReconciliationWorker;
