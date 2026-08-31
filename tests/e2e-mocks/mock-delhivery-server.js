// tests/e2e-mocks/mock-delhivery-server.js
//
// A local stand-in for Delhivery's real B2C shipping API, used ONLY by the
// real full-stack E2E layer via DELHIVERY_BASE_URL in .env.e2e. There is no
// real Delhivery account/sandbox configured in this project (see
// DelhiveryClient.js — the real .env has placeholder credentials for it),
// so this is the external-boundary mock the task's own rules explicitly
// allow ("mock only the external provider boundary" — the real backend's
// shipping.service.js, DelhiveryClient.js, and Prisma Shipment writes all
// still run for real against this).
//
// Response shapes match exactly what shipping.service.js/DelhiveryClient.js
// read back off each real Delhivery endpoint:
//   GET  /c/api/pin-codes/json/?filter_codes=  -> { delivery_codes: [{ postal_code: { pin, cod, pre_paid } }] }
//   POST /api/cmu/create.json (form: format=json&data=<json>) -> { success, packages: [{ waybill, status }] }
//   GET  /api/v1/packages/json/?waybill=       -> { ShipmentData: [{ Shipment: { AWB, Status: { Status, StatusLocation } } }] }
//   POST /api/p/edit (form: data=<json>)       -> { status: true }
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');

const PORT = Number(process.env.MOCK_DELHIVERY_PORT) || 5098;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });
}

async function readFormEncodedData(req) {
  const raw = await readRawBody(req);
  const parsed = querystring.parse(raw);
  try {
    return JSON.parse(parsed.data || '{}');
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/c/api/pin-codes/json/' && req.method === 'GET') {
    // Every pincode is serviceable in the mock — real "not serviceable"/
    // invalid-format paths are already exercised without Delhivery at all
    // (see shipping.service.js's isValidIndianPincodeFormat short-circuit,
    // checked before any Delhivery call).
    return sendJson(res, 200, {
      delivery_codes: [
        { postal_code: { pin: url.searchParams.get('filter_codes'), cod: 'Y', pre_paid: 'Y' } },
      ],
    });
  }

  if (url.pathname === '/api/cmu/create.json' && req.method === 'POST') {
    await readFormEncodedData(req);
    const waybill = `E2E-AWB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return sendJson(res, 200, {
      success: true,
      packages: [{ waybill, status: 'Success', refnum: waybill }],
    });
  }

  if (url.pathname === '/api/v1/packages/json/' && req.method === 'GET') {
    return sendJson(res, 200, {
      ShipmentData: [
        {
          Shipment: {
            AWB: url.searchParams.get('waybill'),
            Status: { Status: 'In Transit', StatusLocation: 'E2E Mock Sorting Hub' },
          },
        },
      ],
    });
  }

  if (url.pathname === '/api/p/edit' && req.method === 'POST') {
    await readFormEncodedData(req);
    return sendJson(res, 200, { status: true });
  }

  sendJson(res, 404, { message: 'Unknown mock-delhivery route' });
});

function start() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[mock-delhivery] listening on http://localhost:${PORT}`);
      resolve(server);
    });
  });
}

module.exports = { start, server, PORT };

if (require.main === module) {
  start();
}
