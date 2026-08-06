// src/jobs/workers/clearCartWorker.js
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const Prisma = require('@config/prisma');

const clearCartWorker = new Worker(
  'clear-cart-queue',
  async (job) => {
    const { userId } = job.data;

    if (!userId) throw new Error('Missing userId');

    await Prisma.cart.deleteMany({ where: { userId } });
    return { message: `Cart with userId ${userId} cleared` };
  },
  {
    connection,
    // Optional: retry config
    settings: {
      retryProcessDelay: 10000, // 10 sec
    },
    attempts: 3,
  }
);

// Logging
clearCartWorker.on('failed', (job, err) => {
  console.error(`❌ Cart clearing failed [${job.id}]: ${err.message}`);
});

clearCartWorker.on('error', (err) => {
  console.error(`❌ Worker-level error: ${err.message}`);
});

module.exports = clearCartWorker;
