// tests/e2e-mocks/mock-msg91-server.js
//
// A local stand-in for MSG91's real OTP API, used ONLY by the real
// full-stack E2E layer (see frontend-improved/e2e-real and
// admin_panel_fixed/e2e-real) via MSG91_SEND_OTP_URL / MSG91_VERIFY_OTP_URL
// in .env.e2e. This lets the real backend's otp.service.js run its real
// fetch()/response-parsing/user-creation logic against a real HTTP server,
// so a browser-driven login test is a genuine end-to-end exercise of the
// OTP flow — not a mocked network call — without ever sending a real SMS.
// There is no real MSG91 sandbox mode to point at instead (see
// otp.service.js's own comment); this mock exists for exactly that gap.
//
// Deliberately NOT a hand-crafted fixture returned to the browser (the
// mocked e2e/ suite already does that) — this is a live process making its
// own decisions, called over real HTTP by the real backend process.
//
// Contract mirrors MSG91's actual response shape closely enough for
// otp.service.js's parseMsg91Response/verifyOtpWithProvider to work
// unmodified: `{ type: 'success' | 'error', message: string }`.
//
// Deterministic by design: ANY phone number's OTP is always "123456" —
// there is nothing to look up because a real SMS never goes out, and every
// real E2E test that logs in already knows to type that code (same
// convention frontend-improved/e2e's mocked auth.spec.js already uses).
const http = require('http');

const VALID_OTP = '123456';
const PORT = Number(process.env.MOCK_MSG91_PORT) || 5099;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/v5/otp' && req.method === 'POST') {
    // send-otp — always "succeeds"; no SMS is ever actually sent.
    return sendJson(res, 200, {
      type: 'success',
      message: 'OTP sent successfully (mock-msg91)',
    });
  }

  if (url.pathname === '/api/v5/otp/verify' && req.method === 'GET') {
    const otp = url.searchParams.get('otp');
    if (otp === VALID_OTP) {
      return sendJson(res, 200, {
        type: 'success',
        message: 'OTP verified success',
      });
    }
    return sendJson(res, 200, {
      type: 'error',
      message: 'OTP not matched',
    });
  }

  sendJson(res, 404, { type: 'error', message: 'Unknown mock-msg91 route' });
});

function start() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[mock-msg91] listening on http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

module.exports = { start, server, PORT, VALID_OTP };

if (require.main === module) {
  start();
}
