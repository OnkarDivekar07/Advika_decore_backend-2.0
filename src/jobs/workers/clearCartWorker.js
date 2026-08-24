// src/jobs/workers/clearCartWorker.js
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const Prisma = require('@config/prisma');
const logger = require('@config/logger');

// Retry/backoff for this queue live on clearCartQueue.js's
// `defaultJobOptions` now, not here — `settings.retryProcessDelay` and a
// bare `attempts` are not valid `WorkerOptions` (BullMQ silently ignores
// unrecognized options), so this job previously got exactly one attempt
// no matter what. `Prisma.cart.deleteMany` is naturally idempotent
// (a no-op on an already-cleared cart), so retrying the whole handler is
// safe with no extra guard needed.
const clearCartWorker = new Worker(
  'clear-cart-queue',
  async (job) => {
    const { userId } = job.data;

    if (!userId) throw new Error('Missing userId');

    await Prisma.cart.deleteMany({ where: { userId } });
    return { message: `Cart with userId ${userId} cleared` };
  },
  { connection }
);

clearCartWorker.on('failed', (job, err) => {
  logger.error(`Cart clearing failed [${job.id}]: ${err.message}`, {
    stack: err.stack,
  });
});

clearCartWorker.on('error', (err) => {
  logger.error(`Worker-level error: ${err.message}`, { stack: err.stack });
});

module.exports = clearCartWorker;
