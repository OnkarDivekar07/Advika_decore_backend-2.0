// src/jobs/queues/fulfillmentReconciliationQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

const fulfillmentReconciliationQueue = new Queue(
  'fulfillment-reconciliation-queue',
  { connection }
);

module.exports = fulfillmentReconciliationQueue;
