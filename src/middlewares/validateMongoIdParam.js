// src/middlewares/validateMongoIdParam.js
//
// Pattern 17 (API abuse/validation audit): a malformed id in a `:id` route
// param (not-a-valid-ObjectId, a path-traversal-like string, a raw NoSQL
// operator string, etc.) was never validated anywhere before reaching
// Prisma — confirmed live: GET /api/products/not-a-valid-id returned a raw
// 500 ("Something went wrong"), not a clean 4xx, because Prisma's MongoDB
// connector throws on a malformed ObjectId and that exception isn't a
// CustomError, so errorHandler.js's default statusCode (500) applies. Not
// a secret-leak (production never shows the raw Prisma message either
// way — see errorHandler.js), but a wrong status code for ordinary bad
// client input, and noisy for error monitoring (Sentry/logs file every one
// of these as a server error to investigate, when it's just garbage
// input).
//
// `isMongoId()` had zero usages anywhere in this codebase before this —
// every `:id` route across the whole app shares this same gap. This
// middleware is the reusable fix, applied here to product.routes.js's
// `:id` routes (the ones actually demonstrated); the same gap almost
// certainly exists on other modules' `:id` routes too and is flagged
// separately as a systemic follow-up, not silently expanded to every
// route in this one change.
const { param } = require('express-validator');

// @param {string} [paramName='id'] - the route param to validate (e.g.
// 'id', 'jobId') — matches whatever the route itself names it.
const validateMongoIdParam = (paramName = 'id') => [
  param(paramName).isMongoId().withMessage(`${paramName} must be a valid id`),
];

module.exports = validateMongoIdParam;
