// src/middlewares/errorHandler.js
const logger = require('@config/logger');

const errorHandler = (err, req, res, next) => {
  // Avoid exposing stack traces in the HTTP response in production —
  // this is unrelated to whether we log it (we always do, below).
  const isDev = process.env.NODE_ENV === 'development';

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Something went wrong';
  const errors = err.errors || null;

  // Always log server-side, regardless of environment — previously this was
  // gated to development only, which meant production errors were only
  // ever visible via Sentry (if configured) and never in the app's own
  // logs. 5xx logs at error level (something we should look at); 4xx logs
  // at warn level (expected client-side failures, e.g. validation).
  const logPayload = {
    statusCode,
    path: req.originalUrl,
    method: req.method,
  };
  if (statusCode >= 500) {
    logger.error(message, { ...logPayload, stack: err.stack });
  } else {
    logger.warn(message, logPayload);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    errors: errors,
    ...(isDev && { stack: err.stack }), // optional debug info
  });
};

module.exports = errorHandler;
