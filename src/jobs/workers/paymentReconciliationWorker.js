// src/jobs/workers/paymentReconciliationWorker.js
//
// Processes the repeating 'sweep' job (see jobs/index.js, which schedules
// it on a fixed interval) that calls payment.service.js's
// reconcileStalePaymentAttempts — the 'timeout' half of the payment state
// machine. Draft orders can otherwise sit at 'pending'/'attempted'/
// 'processing' forever if a customer abandons checkout without Razorpay
// ever having anything to report (no webhook fires for that), so this is
// what eventually closes them out one way or the other instead of leaving
// them in limbo.
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const logger = require('@config/logger');
const paymentService = require('@modules/payment/payment.service');

const paymentReconciliationWorker = new Worker(
  'payment-reconciliation-queue',
  async () => {
    const results = await paymentService.reconcileStalePaymentAttempts();
    if (results.timedOut > 0 || results.reconciledPaid > 0 || results.unknown > 0) {
      logger.info('Payment attempt reconciliation swept stale orders', results);
    }
    return results;
  },
  { connection }
);

paymentReconciliationWorker.on('failed', (job, err) => {
  console.error(`❌ Payment reconciliation sweep failed [${job.id}]: ${err.message}`);
});

paymentReconciliationWorker.on('error', (err) => {
  console.error(`❌ Worker-level error: ${err.message}`);
});

module.exports = paymentReconciliationWorker;
