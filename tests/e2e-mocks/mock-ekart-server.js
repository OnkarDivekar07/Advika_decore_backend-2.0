// tests/e2e-mocks/mock-ekart-server.js
//
// A local stand-in for Ekart Logistics' real B2C shipping API, used ONLY by
// the real full-stack E2E layer via EKART_BASE_URL in .env.e2e. There is no
// real Ekart account/sandbox configured in this project (see EkartClient.js
// — the real .env has placeholder credentials for it), so this is the
// external-boundary mock the task's own rules explicitly allow ("mock only
// the external provider boundary" — the real backend's shipping.service.js,
// EkartClient.js, and Prisma Shipment writes all still run for real against
// this).
//
// Response shapes match exactly what shipping.service.js reads back off
// each EkartClient call (see that file):
//   checkServiceability -> { serviceable, estimated_delivery_days, cod_available }
//   createShipment      -> { tracking_id, awb_number, estimated_delivery_days }
//   trackShipment        -> { status_code, current_location }
//   cancelShipment        -> { success: true }
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MOCK_EKART_PORT) || 5098;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/v1/serviceability' && req.method === 'POST') {
    await readBody(req);
    // Every pincode is serviceable in the mock — real "not serviceable"/
    // invalid-format paths are already exercised without Ekart at all (see
    // shipping.service.js's isValidIndianPincodeFormat short-circuit,
    // checked before any Ekart call).
    return sendJson(res, 200, {
      serviceable: true,
      estimated_delivery_days: 3,
      cod_available: true,
    });
  }

  if (url.pathname === '/v1/shipments' && req.method === 'POST') {
    await readBody(req);
    const trackingId = `E2E-AWB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return sendJson(res, 200, {
      tracking_id: trackingId,
      awb_number: trackingId,
      estimated_delivery_days: 3,
    });
  }

  const trackMatch = url.pathname.match(/^\/v1\/shipments\/([^/]+)\/track$/);
  if (trackMatch && req.method === 'GET') {
    return sendJson(res, 200, {
      status_code: 'IN_TRANSIT',
      current_location: 'E2E Mock Sorting Hub',
    });
  }

  const cancelMatch = url.pathname.match(/^\/v1\/shipments\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    await readBody(req);
    return sendJson(res, 200, { success: true });
  }

  sendJson(res, 404, { message: 'Unknown mock-ekart route' });
});

function start() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[mock-ekart] listening on http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

module.exports = { start, server, PORT };

if (require.main === module) {
  start();
}
