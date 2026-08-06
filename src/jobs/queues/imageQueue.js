const { Queue } = require('bullmq');
const connection = require('@config/redis');

const imageQueue = new Queue('image-processing-queue', { connection });

module.exports = imageQueue;
