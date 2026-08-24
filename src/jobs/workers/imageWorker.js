const { Worker } = require('bullmq');
const connection = require('@config/redis');
const awsService = require('../../services/external/AWSUploads');
const { compressImageBuffer } = require('@utils/imageUtils');
const { generateUniqueProductFilenames } = require('@utils/bannerHelpers');
const Prisma = require('@config/prisma');
const invalidateCacheByPrefix = require('@utils/invalidateCacheByPrefix');
const { PRODUCT_CACHE_PREFIXES } = require('@modules/product/product.service');
const logger = require('@config/logger');

// See product.service.js's invalidateProductCaches for why both prefixes
// need clearing — this worker is the only place a create/update job
// actually lands in Prisma, so it's the only place that can know the
// write has happened and it's safe to drop the stale cached list.
//
// Deliberately swallows its own failure (logs, never throws): this now
// runs after a real `attempts`/`backoff` retry policy was added to
// imageQueue.js (see that file's comment), and the Prisma
// create/update above it has already committed by the time this runs.
// If invalidation threw and were allowed to fail the job, BullMQ would
// retry the *whole* handler on the next attempt — re-running
// Prisma.product.create() and silently duplicating the product. A
// stale cached list for up to its own cacheExpiry is a fully recoverable
// cost; a duplicate product row is not.
const invalidateProductCaches = async () => {
  try {
    await Promise.all(
      PRODUCT_CACHE_PREFIXES.map((prefix) => invalidateCacheByPrefix(prefix))
    );
  } catch (err) {
    logger.error(
      `Product cache invalidation failed after a successful write: ${err.message}`
    );
  }
};

const imageWorker = new Worker(
  'image-processing-queue',
  async (job) => {
    const { name } = job;

    if (name === 'create-product') {
      const { serializedImages: images, productInfo } = job.data;

      if (!Array.isArray(images)) throw new Error('images should be an array');

      const uploadedUrls = [];

      for (const image of images) {
        const buffer = Buffer.from(image.buffer, 'base64');
        const compressedBuffer = await compressImageBuffer(buffer);
        const uniqueName = generateUniqueProductFilenames([
          image.originalname,
        ])[0];
        const s3Url = await awsService.uploadToS3(compressedBuffer, uniqueName);
        uploadedUrls.push(s3Url);
      }

      const created = await Prisma.product.create({
        data: {
          ...productInfo,
          price: parseFloat(productInfo.price),
          stock: parseInt(productInfo.stock),
          images: uploadedUrls,
        },
      });

      // Drop the cached product list(s) now that a new row actually
      // exists — without this, GET /api/products (and the storefront's
      // new-arrivals rail) could keep serving a list without this
      // product for up to their cacheExpiry.
      await invalidateProductCaches();

      // Returned as job.returnvalue — see product.service's
      // getProductJobStatus, which the admin panel polls after a create
      // to learn the real product id once this job completes.
      return { id: created.id, images: uploadedUrls };
    }

    if (name === 'update-product') {
      const { productId, serializedImages, updateData } = job.data;
      const uploadedUrls = [];

      for (const image of serializedImages) {
        const buffer = Buffer.from(image.buffer, 'base64');
        const compressedBuffer = await compressImageBuffer(buffer);
        const uniqueName = generateUniqueProductFilenames([
          image.originalname,
        ])[0];
        const s3Url = await awsService.uploadToS3(compressedBuffer, uniqueName);
        uploadedUrls.push(s3Url);
      }

      if (uploadedUrls.length) {
        updateData.images = uploadedUrls;
      }

      await Prisma.product.update({
        where: { id: productId },
        data: updateData,
      });

      await invalidateProductCaches();

      return { id: productId, images: uploadedUrls };
    }

    throw new Error(`Unknown job type: ${name}`);
  },
  { connection }
);

imageWorker.on('failed', (job, err) => {
  logger.error(`Job failed [${job.name} - ${job.id}]: ${err.message}`, {
    stack: err.stack,
  });
});

imageWorker.on('error', (err) => {
  logger.error(`Worker encountered an error: ${err.message}`, {
    stack: err.stack,
  });
});

module.exports = imageWorker;
