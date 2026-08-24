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

// How long this endpoint waits for the database before giving up and
// reporting unhealthy. Prisma's MongoDB connector defaults to a 30s
// serverSelectionTimeoutMS when the database is unreachable — far past
// this repo's own docker-compose healthcheck (interval 10s / timeout 5s),
// so an outage previously meant every health probe would time out from
// the orchestrator's side without ever seeing this endpoint's actual
// {status:'error'} response, and each check left a connection attempt
// running in the background. Racing against a short local timeout makes
// "database is down" fail fast and observable instead.
const DB_PING_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // Don't let this timer alone keep the process (or a test runner) alive
    // if it's still pending when everything else has settled/exited.
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

router.get('/', async (req, res) => {
  const checks = {};
  let healthy = true;

  // Prisma / MongoDB — `$runCommandRaw` with a `ping` is the standard
  // lightweight liveness check for Prisma's MongoDB connector (there's no
  // raw SQL to run against Mongo, so $queryRaw isn't an option here).
  try {
    await withTimeout(prisma.$runCommandRaw({ ping: 1 }), DB_PING_TIMEOUT_MS);
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
