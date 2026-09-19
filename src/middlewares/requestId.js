// src/middlewares/requestId.js
//
// A per-request correlation id — generated here (not trusted from an
// inbound header, so a client can't spoof one that collides with or
// impersonates another real request's id), stamped on `req.id`, and
// echoed back as `X-Request-Id` on every response. errorHandler.js
// includes the same id in both its server-side log line and the
// client-facing error JSON, so a customer/support report ("I got an
// error") can be matched back to the exact log entry without the
// response ever needing to carry a stack trace, file path, or query
// detail itself.
const crypto = require('crypto');

const requestId = (req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestId;
