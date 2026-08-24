require('module-alias/register');
require('@config/env'); // validate all required env vars before anything else boots
const { Sentry } = require('@config/sentry'); // must load before the app so instrumentation can attach
const app = require('./src/app');
const logger = require('@config/logger');
const prisma = require('@config/prisma');
const redis = require('@config/redis');
const jobs = require('./src/jobs');

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});

// Graceful shutdown — on `SIGTERM` (sent by pm2/Docker/most hosting
// platforms before a deploy or restart kills the process) and `SIGINT`
// (Ctrl+C locally), stop taking new work and let what's already in flight
// finish cleanly instead of dropping it:
//   1. Stop the HTTP server from accepting new connections; let in-flight
//      requests finish.
//   2. Stop the BullMQ queues/workers, letting any job currently running
//      finish first.
//   3. Close the Prisma connection.
//   4. Quit the shared Redis connection (used by both BullMQ and any
//      direct caching) last, since the steps above may still need it.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  // Don't hang forever if something above gets stuck — force-exit after a
  // timeout so an orchestrator doesn't have to SIGKILL us.
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15000);
  forceExitTimer.unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');

    await jobs.shutdown();

    await prisma.$disconnect();
    logger.info('Prisma connection closed');

    await redis.quit();
    logger.info('Redis connection closed');

    // Sentry's transport batches/sends asynchronously — without this, a
    // captureException() from the uncaughtException/unhandledRejection
    // handlers below can lose the event to process.exit() before it ever
    // leaves the process. No-op when Sentry was never initialized.
    await Sentry.close(2000);

    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err) {
    logger.error(`Error during graceful shutdown: ${err.message}`);
    await Sentry.close(2000).catch(() => {});
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A bug that throws outside any request handler (a stray callback, a timer,
// a rejected promise nobody attached a .catch to) previously had nowhere to
// go — Express's own error handling only covers what happens inside a
// request. Left unhandled, Node either silently swallows it (older
// versions) or kills the process instantly with no report anywhere (current
// versions' default `unhandledRejection` behavior, and always for
// `uncaughtException`). Both cases here: log it, send it to Sentry (a
// no-op if SENTRY_DSN isn't set — see @config/sentry), then go through the
// same graceful-shutdown path SIGTERM/SIGINT use so an orchestrator
// restarts a clean process rather than one left in a possibly-corrupted
// state. `shutdown()` already guards against running twice.
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled promise rejection: ${error.stack || error.message}`);
  Sentry.captureException(error);
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
  Sentry.captureException(err);
  shutdown('uncaughtException');
});
