// src/config/sentry.js
//
// Error tracking so exceptions in production surface somewhere other than
// "whoever next SSHes in and greps the logs". Entirely optional: with no
// SENTRY_DSN set, `isEnabled` is false and every call here is a no-op, so
// this is safe to import in any environment (local dev, CI, etc.) without
// requiring a Sentry account.
//
// Must be required before anything else (see server.js) so Sentry's
// auto-instrumentation can hook into modules (http, express, etc.) as they
// load — requiring it later misses that instrumentation.
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;
const isEnabled = Boolean(dsn);

if (isEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
}

module.exports = { Sentry, isEnabled };
