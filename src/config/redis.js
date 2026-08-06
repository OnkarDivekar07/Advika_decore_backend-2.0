const Redis = require('ioredis');

if (!process.env.REDIS_URL) {
  throw new Error('Missing required environment variable: REDIS_URL');
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

module.exports = redis;
