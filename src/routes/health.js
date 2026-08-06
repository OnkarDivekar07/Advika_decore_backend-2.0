// src/routes/health.js
//
// GET /health — for hosting-platform health checks / uptime monitors.
// Verifies both dependencies the app can't run without (DB via Prisma,
// cache/queue via Redis) instead of just confirming the Node process is up.
const express = require('express');
const router = express.Router();

const prisma = require('@config/prisma');
const redis = require('@config/redis');
const logger = require('@config/logger');

router.get('/', async (req, res) => {
  const checks = {};
  let healthy = true;

  // Prisma / MongoDB — `$runCommandRaw` with a `ping` is the standard
  // lightweight liveness check for Prisma's MongoDB connector (there's no
  // raw SQL to run against Mongo, so $queryRaw isn't an option here).
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    checks.database = 'ok';
  } catch (err) {
    healthy = false;
    checks.database = 'error';
    logger.error(`Health check: database ping failed: ${err.message}`);
  }

  // Redis — also backs BullMQ, so this doubles as a queue liveness check.
  try {
    if (redis.status !== 'ready') {
      throw new Error(`redis status is "${redis.status}", not "ready"`);
    }
    await redis.ping();
    checks.redis = 'ok';
  } catch (err) {
    healthy = false;
    checks.redis = 'error';
    logger.error(`Health check: redis ping failed: ${err.message}`);
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'error',
    checks,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
