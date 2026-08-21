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

// PHASE 15 — Security Hardening: "prevent accidental token leakage in
// logs". Sentry's Express instrumentation attaches the incoming request
// (headers, body, cookies) to every event by default, which — unfiltered —
// would ship an admin's `Authorization: Bearer <jwt>` header, a customer's
// session cookie, or a raw password/OTP field straight into a third-party
// dashboard the moment any route throws. This isn't hypothetical: an admin
// hitting a bug on ANY authenticated screen (not just admin ones) throws
// with their live token sitting right there in req.headers.
//
// Two independent layers, since either one failing shouldn't be the only
// thing standing between a token and Sentry's servers:
//   1. `sendDefaultPii: false` (the default, but pinned explicitly here so
//      it can't silently flip if someone "cleans up" this config later) —
//      keeps Sentry from attaching cookies/IP by default at the SDK level.
//   2. `beforeSend`/`beforeSendTransaction` below — a last-line scrub that
//      redacts known-sensitive header and body field names on every event
//      right before it leaves the process, regardless of what any SDK
//      default does or how a future Sentry version behaves.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-razorpay-signature',
  'x-ekart-signature',
]);

// Matches by substring so this also catches variants like `otpCode`,
// `newPassword`, `cardNumber`, `accessToken`, `refreshToken`, etc.,
// without having to enumerate every field name used across every module.
const SENSITIVE_KEY_PATTERN =
  /token|password|secret|authorization|otp|cvv|card|pin\b/i;

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
      ? '[Filtered]'
      : value;
  }
  return redacted;
}

// Shallow-plus-one-level redaction is deliberate: every real payload this
// app ever sends (login body, OTP verify body, address forms, product
// forms) is a flat or one-level-nested object, never deep/circular JSON —
// so this doesn't need general-purpose recursive traversal to be
// effective, and staying shallow keeps it cheap to run on every event.
function redactSensitiveKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveKeys(item, depth + 1));
  }
  const redacted = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      redacted[key] = '[Filtered]';
    } else if (val && typeof val === 'object') {
      redacted[key] = redactSensitiveKeys(val, depth + 1);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

function scrubEvent(event) {
  if (event.request) {
    if (event.request.headers) {
      event.request.headers = redactHeaders(event.request.headers);
    }
    if (event.request.cookies) {
      event.request.cookies = '[Filtered]';
    }
    if (event.request.data) {
      event.request.data = redactSensitiveKeys(event.request.data);
    }
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      if (crumb?.data) {
        return { ...crumb, data: redactSensitiveKeys(crumb.data) };
      }
      return crumb;
    });
  }
  return event;
}

if (isEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
}

module.exports = { Sentry, isEnabled, __test: { redactHeaders, redactSensitiveKeys, scrubEvent } };
