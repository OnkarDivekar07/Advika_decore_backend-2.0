// tests/e2e-mocks/start-e2e-mocks.js
// Starts the mock MSG91 + mock Delhivery HTTP servers together in one
// process, for the real full-stack E2E layer. Run via `npm run e2e:mocks`
// (backend 2.0/package.json). Neither mock talks to the real backend or a
// real external provider — they only exist so the real backend's own
// otp.service.js / DelhiveryClient.js code has something real to call
// over HTTP during an E2E run.
const msg91 = require('./mock-msg91-server');
const delhivery = require('./mock-delhivery-server');

Promise.all([msg91.start(), delhivery.start()]).then(() => {
  console.log('[e2e-mocks] both mock servers are up.');
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
