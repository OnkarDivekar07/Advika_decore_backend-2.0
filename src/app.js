const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('@config/swagger');
const logger = require('@config/logger');
const { Sentry, isEnabled: sentryEnabled } = require('@config/sentry');
const CustomError = require('@utils/customError');

// Load environment variables
require('dotenv').config();

const routes = require('./routes/apiRoutes'); // Auto-indexed route imports
const healthRoute = require('./routes/health');
const errorHandler = require('@middlewares/errorHandler');

const app = express();

// Trust exactly one hop of `X-Forwarded-For`. Confirmed for this app's
// actual deployment: DigitalOcean App Platform puts its own managed
// router/ingress in front of the app container — exactly one hop — which
// sets X-Forwarded-For to the real client IP before the request ever
// reaches this process. (Same is true for Render/Railway/Fly.io/
// Heroku-style platforms in general, if this ever moves.) Without this,
// `req.ip` would resolve to that router's own address for every request,
// which would make the IP-keyed rate limiters below
// (adminLoginIpRateLimiter/otpSendIpRateLimiter — see
// @middlewares/rateLimiter) bucket every real visitor together under one
// shared key instead of limiting each attacker individually.
//
// IMPORTANT if the deployment topology ever changes: `1` is only correct
// for exactly one trusted hop in front of this process. Moving to a setup
// with Node exposed directly to the internet (no proxy at all) makes this
// actively dangerous — an attacker can then fake X-Forwarded-For and the
// app will believe it, which defeats the IP rate limiters rather than
// just failing to help. Moving to a setup with a SECOND proxy hop (e.g.
// adding an Nginx in front of the App Platform routing) needs this bumped
// to `2` instead, or the real attacker IP gets skipped over.
//
// Harmless in local dev with no proxy in front: with no
// `X-Forwarded-For` header, Express just falls back to the raw socket
// address, same as before this setting existed.
app.set('trust proxy', 1);

// Global Middleware
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(require('@middlewares/requestId'));
app.use(require('@middlewares/responseMiddleware'));
app.use(
  express.json({
    // Stash the raw bytes on the request. The Razorpay webhook has to verify
    // an HMAC signature computed over the exact body Razorpay sent — re-serializing
    // req.body back to JSON can reorder keys/whitespace and break that check.
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / server-to-server requests with no Origin header
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Pattern 17 (API abuse/validation audit): a plain `new Error(...)`
      // here isn't a CustomError, so errorHandler.js's default statusCode
      // (500) applied — confirmed live (a disallowed Origin got "Something
      // went wrong" / 500). Not a security gap (no CORS headers are set
      // either way, so a browser still blocks the disallowed origin's JS
      // from reading the response), but the wrong status code for what is
      // ordinary, expected rejection of an unrecognized origin.
      return callback(new CustomError('Not allowed by CORS', 403));
    },
  })
);
// contentSecurityPolicy stays off outside production: swagger-ui-express
// (mounted below, dev/staging only) renders its own inline scripts/styles
// and a strict CSP would break that page — nothing about this app's own
// behavior depends on the relaxed policy. In production, where Swagger is
// never mounted, this is a pure JSON API with no HTML of its own to load
// scripts/styles/frames into, so `default-src 'self'` costs nothing and
// closes off anything that *would* try to load external content if some
// future bug ever caused this API to reflect attacker-controlled HTML.
// frameguard/hsts are safe to tighten unconditionally — neither affects
// Swagger UI.
const isProd = process.env.NODE_ENV === 'production';
app.use(
  helmet({
    contentSecurityPolicy: isProd
      ? { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } }
      : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  })
);
// HTTP access log — piped through Winston (see @config/logger) instead of
// straight to stdout, so it's structured JSON in production and can be
// shipped to a log aggregator alongside the rest of the app's logs.
app.use(morgan('combined', { stream: logger.stream }));
app.use(express.static(path.join(__dirname, '../public'))); // static files

// Swagger docs are internal API documentation — never expose in production
if (process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

const initJobs = require('./jobs');
// Each individual sweep registration already catches its own failure (see
// jobs/index.js) — this call itself should never actually reject, but
// `.catch()` here is the difference between "impossible" and "definitely
// can't produce an unhandled rejection that takes the whole process down"
// (server.js's own unhandledRejection handler treats one as fatal).
initJobs().catch((err) => logger.error(`initJobs() failed: ${err?.message}`, { stack: err?.stack })); // 🔥 Start all workers

// Health check — kept outside /api so hosting platforms / uptime monitors
// can hit it directly at /health.
app.use('/health', healthRoute);

// Routes
app.use('/api', routes);

// Sentry must be wired in after all routes and before our own error handler:
// it records the exception then calls next(err) so errorHandler below still
// runs and shapes the HTTP response as before. No-op when SENTRY_DSN isn't set.
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app);
}

// Global Error Handler
app.use(errorHandler);

module.exports = app;
