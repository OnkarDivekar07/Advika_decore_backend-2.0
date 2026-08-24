const Redis = require('ioredis');
const logger = require('./logger');

if (!process.env.REDIS_URL) {
  throw new Error('Missing required environment variable: REDIS_URL');
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error(`Redis error: ${err.message}`);
});

module.exports = redis;
