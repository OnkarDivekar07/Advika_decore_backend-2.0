// src/jobs/queues/paymentReconciliationQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

const paymentReconciliationQueue = new Queue('payment-reconciliation-queue', {
  connection,
});

module.exports = paymentReconciliationQueue;
