// src/jobs/index.js
const logger = require('@config/logger');

const imageWorker = require('./workers/imageWorker');
const clearCartWorker = require('./workers/clearCartWorker');
const notificationWorker = require('./workers/notificationWorker');
const imageQueue = require('./queues/imageQueue');
const clearCartQueue = require('./queues/clearCartQueue');
const notificationQueue = require('./queues/notificationQueue');

const workers = [imageWorker, clearCartWorker, notificationWorker];
const queues = [imageQueue, clearCartQueue, notificationQueue];

module.exports = () => {
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
