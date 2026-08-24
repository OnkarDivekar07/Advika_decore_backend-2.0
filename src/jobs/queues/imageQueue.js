const { Queue } = require('bullmq');
const connection = require('@config/redis');

// A transient S3/Prisma failure during create-product/update-product
// previously failed the job outright on its first try (no `attempts`
// configured anywhere for this queue), silently losing an admin's
// uploaded images/product data unless they happened to notice via
// getProductJobStatus polling. See clearCartQueue.js's comment for why
// this lives here (Queue defaultJobOptions), not on the Worker.
const imageQueue = new Queue('image-processing-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
  },
});

module.exports = imageQueue;
