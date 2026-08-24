// src/jobs/queues/notificationQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

// See clearCartQueue.js's comment — `attempts`/`backoff` live on the Queue,
// not the Worker. This is the order-confirmation SMS queue; a transient
// MSG91/network blip previously meant that SMS silently never went out.
const notificationQueue = new Queue('notification-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
  },
});

module.exports = notificationQueue;
