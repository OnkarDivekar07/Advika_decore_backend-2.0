// src/jobs/queues/refundReconciliationQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

const refundReconciliationQueue = new Queue('refund-reconciliation-queue', {
  connection,
});

module.exports = refundReconciliationQueue;
