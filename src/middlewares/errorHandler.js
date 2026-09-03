// src/middlewares/errorHandler.js
const logger = require('@config/logger');
const CustomError = require('@utils/customError');

const errorHandler = (err, req, res, next) => {
  // Avoid exposing stack traces in the HTTP response in production —
  // this is unrelated to whether we log it (we always do, below).
  const isDev = process.env.NODE_ENV === 'development';

  const statusCode = err.statusCode || 500;

  // Only a deliberately authored CustomError's message was ever written
  // with an end user in mind — every service in this app throws one for
  // exactly that reason (see @utils/customError). Anything else (a raw
  // Prisma/MongoDB error, or any other unexpected exception) was never
  // meant to be read by a client and can genuinely leak internals: e.g.
  // Prisma's own P2034 message includes the exact server file path and
  // line number that threw (confirmed live via the real E2E concurrency
  // spec — see @utils/withTransactionRetry, which now retries that
  // specific error instead of ever letting it reach here in the first
  // place, but this is the backstop for every OTHER kind of raw error).
  // Dev keeps seeing the real message for debugging; the full detail is
  // always logged server-side below regardless of environment.
  const isSafeToShow = err instanceof CustomError || isDev;
  const message = isSafeToShow ? err.message || 'Something went wrong' : 'Something went wrong';
  const errors = err.errors || null;

  // Always log server-side, regardless of environment — previously this was
  // gated to development only, which meant production errors were only
  // ever visible via Sentry (if configured) and never in the app's own
  // logs. 5xx logs at error level (something we should look at); 4xx logs
  // at warn level (expected client-side failures, e.g. validation). Always
  // logs the REAL message/stack, never the client-facing fallback above.
  const logPayload = {
    statusCode,
    path: req.originalUrl,
    method: req.method,
  };
  if (statusCode >= 500) {
    logger.error(err.message, { ...logPayload, stack: err.stack });
  } else {
    logger.warn(err.message, logPayload);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    errors: errors,
    ...(isDev && { stack: err.stack }), // optional debug info
  });
};

module.exports = errorHandler;
