const { Worker } = require('bullmq');
const connection = require('@config/redis');
const awsService = require('../../services/external/AWSUploads');
const { compressImageBuffer } = require('@utils/imageUtils');
const { generateUniqueProductFilenames } = require('@utils/bannerHelpers');
const Prisma = require('@config/prisma');

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

      await Prisma.product.create({
        data: {
          ...productInfo,
          price: parseFloat(productInfo.price),
          stock: parseInt(productInfo.stock),
          images: uploadedUrls,
        },
      });

      return uploadedUrls;
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

      return uploadedUrls;
    }

    throw new Error(`Unknown job type: ${name}`);
  },
  { connection }
);

// ✅ Log job errors
imageWorker.on('failed', (job, err) => {
  console.error(`❌ Job failed [${job.name} - ${job.id}]: ${err.message}`);
  console.error(err.stack);
});

// ✅ Log worker-level errors
imageWorker.on('error', (err) => {
  console.error(`❌ Worker encountered an error: ${err.message}`);
});

module.exports = imageWorker;
