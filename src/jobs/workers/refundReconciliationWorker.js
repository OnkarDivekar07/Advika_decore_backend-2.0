// src/jobs/workers/refundReconciliationWorker.js
//
// Processes the repeating 'sweep' job (see jobs/index.js, which schedules
// it on a fixed interval) that calls payment.service.js's
// reconcileUnresolvedRefunds — the actual retry/repair mechanism behind
// the "refund has a failure window" gap: a real Razorpay refund can
// succeed while the local write meant to record it independently fails,
// leaving Order.paymentStatus stuck at 'paid' with nothing — not even the
// refund.processed webhook — able to find its way back to it, since that
// webhook's own reconciliation only ever matched an order already at
// 'refund_pending'. This sweep works from the RefundAttempt ledger
// instead, which is durable from the moment a refund is first requested.
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const logger = require('@config/logger');
const paymentService = require('@modules/payment/payment.service');

const refundReconciliationWorker = new Worker(
  'refund-reconciliation-queue',
  async () => {
    const results = await paymentService.reconcileUnresolvedRefunds();
    if (results.checked > 0) {
      logger.info('Refund reconciliation swept unresolved refund attempts', results);
    }
    return results;
  },
  { connection }
);

refundReconciliationWorker.on('failed', (job, err) => {
  logger.error(
    `Refund reconciliation sweep failed [${job.id}]: ${err.message}`,
    { stack: err.stack }
  );
});

refundReconciliationWorker.on('error', (err) => {
  logger.error(`Worker-level error: ${err.message}`, { stack: err.stack });
});

module.exports = refundReconciliationWorker;
