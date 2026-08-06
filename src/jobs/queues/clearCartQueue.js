// src/queues/clearCartQueue.js
const { Queue } = require('bullmq');
const connection = require('@config/redis');

const clearCartQueue = new Queue('clear-cart-queue', { connection });

module.exports = clearCartQueue;
