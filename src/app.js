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

// Global Middleware
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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
app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false })
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
