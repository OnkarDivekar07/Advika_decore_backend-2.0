// src/config/logger.js
//
// Structured logging via Winston, sitting alongside morgan's HTTP access
// log (morgan is piped through this logger's stream — see app.js) rather
// than replacing it. In production this emits single-line JSON so it can
// be shipped to a log aggregator (CloudWatch, Datadog, ELK, etc.) later
// without any further changes here; in development it prints colorized,
// human-readable lines instead.
const winston = require('winston');

const isProduction = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: { service: 'backend-2.0' },
  format: isProduction
    ? winston.format.combine(winston.format.timestamp(), winston.format.json())
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          delete meta.service;
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} ${level}: ${stack || message}${extra}`;
        })
      ),
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

// Adapter so morgan can write its access-log lines through Winston instead
// of straight to stdout — `app.use(morgan('combined', { stream: logger.stream }))`.
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
