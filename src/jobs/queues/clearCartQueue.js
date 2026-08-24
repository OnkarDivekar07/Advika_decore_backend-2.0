// src/queues/clearCartQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

// `attempts`/`backoff` belong here — on the Queue's `defaultJobOptions` (or
// per-call in `queue.add(name, data, opts)`) — not on the Worker. BullMQ's
// `WorkerOptions` has no `attempts`/`settings.retryProcessDelay` field (that
// was Bull v3's shape); passing them there is silently ignored, which is
// what clearCartWorker.js used to do — every job got exactly one attempt
// despite looking retry-configured. See notificationQueue.js for the same
// fix applied to the order-confirmation SMS queue.
const clearCartQueue = new Queue('clear-cart-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
  },
});

module.exports = clearCartQueue;
