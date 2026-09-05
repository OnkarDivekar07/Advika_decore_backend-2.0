// tests/e2e-helpers/loadTestPeakHour.js
//
// The counterpart to loadTestConcurrency.js's oversell/duplicate/CAS races
// — those deliberately fire every request in the exact same instant at one
// document, to prove the app never corrupts data even in an adversarial
// worst case. This script does the opposite on purpose: many DIFFERENT
// products, a pool of REUSED buyers (like real repeat traffic), and orders
// arriving at randomized (Poisson-ish) intervals over real wall-clock time
// instead of all at once — the shape a real busy period actually has.
//
// What this measures: whether this app's own checkout logic, on THIS
// sandbox's single dev-mode server, stays correct and keeps up under a
// paced, realistic-shaped order rate. What it does NOT measure: real
// production capacity — that depends on the real deployment's server specs
// and PM2 cluster size, which this sandbox doesn't share. Read the
// latency/success numbers as "this app's logic under load," not "your
// production server's ceiling."
//
// Runs ONLY against the dedicated E2E backend + its dedicated `*_e2e`
// database — same guard as loadTestConcurrency.js and prisma/reset-e2e.js.
//
// Usage:
//   npm run e2e:load-test:peak
//   LOAD_TEST_ORDERS=300 LOAD_TEST_AVG_INTERVAL_MS=1500 npm run e2e:load-test:peak
require('module-alias/register');
const prisma = require('@config/prisma');

const API_BASE = process.env.LOAD_TEST_API_URL || 'http://localhost:5001';
const VALID_OTP = '123456';
const RUN_ID = Date.now().toString(36);

const dbUrl = process.env.DATABASE_URL || '';
if (!/\/[^/?]*_e2e(\?|$)/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a dedicated "*_e2e" database.\n` +
      `This script creates real orders/users against whatever DATABASE_URL points at — it only ever runs against the E2E database.`
  );
  process.exit(1);
}

const PRODUCT_COUNT = Number(process.env.LOAD_TEST_PRODUCTS) || 20;
const PRODUCT_STOCK = Number(process.env.LOAD_TEST_PRODUCT_STOCK) || 200;
const BUYER_POOL_SIZE = Number(process.env.LOAD_TEST_BUYER_POOL) || 30;
const TOTAL_ORDERS = Number(process.env.LOAD_TEST_ORDERS) || 200;
const AVG_INTERVAL_MS = Number(process.env.LOAD_TEST_AVG_INTERVAL_MS) || 2000;

async function request(method, path, { token, body } = {}) {
  const started = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, body: json, ms: Date.now() - started };
}

// Offset by wall-clock start time so a rerun without an e2e:reset-db in
// between doesn't re-log buyer N into the same E2E user account as a
// previous run — see loadTestConcurrency.js's freshPhone for the failure
// mode this avoids.
const PHONE_BASE = 700000000 + (Date.now() % 90000000);
let phoneCounter = 0;
function freshPhone() {
  phoneCounter += 1;
  return `9${String(PHONE_BASE + phoneCounter).padStart(9, '0')}`;
}

async function loginFreshBuyer() {
  const e164 = `+91${freshPhone()}`;
  await request('POST', '/api/otp/send-otp', { body: { phone: e164 } });
  const verify = await request('POST', '/api/otp/verify-otp', {
    body: { phone: e164, otp: VALID_OTP },
  });
  const token = verify.body?.data?.token;
  if (!token) throw new Error(`Login failed for ${e164}: ${JSON.stringify(verify.body)}`);
  return token;
}

async function makeProduct(index) {
  return prisma.product.create({
    data: {
      name: `Peak Hour Load Test Product ${RUN_ID}-${index}`,
      category: ['Rubber & Matting'],
      brand: 'Advika',
      price: 299 + index * 10,
      stock: PRODUCT_STOCK,
      images: [],
      description: 'Synthetic product created by loadTestPeakHour.js — safe to delete.',
    },
  });
}

// Exponential inter-arrival times average to AVG_INTERVAL_MS over many
// draws — the standard way to simulate a Poisson arrival process (random,
// independent order arrivals at a steady average rate), rather than a
// perfectly metronomic "one every N ms", which real traffic never is.
function exponentialInterval(meanMs) {
  return -Math.log(1 - Math.random()) * meanMs;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function setUpBuyerIdentity() {
  const token = await loginFreshBuyer();
  const address = await request('POST', '/api/user/address', {
    token,
    body: {
      name: 'Peak Hour Buyer',
      phone: `+91${freshPhone()}`,
      pincode: '411001',
      city: 'Pune',
      state: 'Maharashtra',
      houseArea: '1 Load Test Lane',
      area: 'Kothrud',
    },
  });
  return { token, addressId: address.body?.data?.id };
}

// One simulated customer's full checkout, for one order: add to cart,
// create/refresh the draft order, place COD. Real customers occasionally
// fail at any of these steps (a stale cart, a validation hiccup) — all
// three are timed and counted, not just the final placement.
async function placeOneOrder(buyer, product) {
  const startedAt = Date.now();
  const cartRes = await request('PUT', '/api/cart', {
    token: buyer.token,
    body: { productId: product.id, quantity: 1 },
  });
  if (cartRes.status !== 200) {
    return { outcome: 'cart_failed', status: cartRes.status, ms: Date.now() - startedAt };
  }

  const draftRes = await request('POST', '/api/order', {
    token: buyer.token,
    body: { selectedAddressId: buyer.addressId },
  });
  const orderId = draftRes.body?.data?.id;
  if (draftRes.status !== 201 || !orderId) {
    return { outcome: 'draft_failed', status: draftRes.status, ms: Date.now() - startedAt };
  }

  const codRes = await request('POST', '/api/payment/cod', {
    token: buyer.token,
    body: { orderId, method: 'cod' },
  });
  const ms = Date.now() - startedAt;

  if (codRes.status === 200) return { outcome: 'success', status: 200, ms, productId: product.id };
  if (codRes.status === 409) return { outcome: 'conflict', status: 409, ms, productId: product.id };
  return { outcome: 'error', status: codRes.status, ms, productId: product.id, body: codRes.body };
}

async function main() {
  console.log(`Peak-hour traffic simulation against ${API_BASE} (run ${RUN_ID})`);
  console.log(
    `${TOTAL_ORDERS} orders, spread across ${PRODUCT_COUNT} products, ${BUYER_POOL_SIZE} reused buyers, ` +
      `Poisson-paced at an average of one every ${AVG_INTERVAL_MS}ms.`
  );
  console.log('Measures this app\'s own checkout logic under a realistic-shaped rate — not production server capacity.\n');

  console.log('Setting up catalog and buyer pool (not timed — this is fixture setup, not the simulated traffic)...');
  const products = [];
  for (let i = 0; i < PRODUCT_COUNT; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    products.push(await makeProduct(i));
  }
  const buyers = [];
  for (let i = 0; i < BUYER_POOL_SIZE; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    buyers.push(await setUpBuyerIdentity());
  }
  console.log(`Ready: ${products.length} products (stock ${PRODUCT_STOCK} each), ${buyers.length} buyer identities.\n`);

  console.log('Simulating traffic...');
  const results = [];
  const runStart = Date.now();
  let scheduledAt = 0;
  const scheduledRuns = [];

  for (let i = 0; i < TOTAL_ORDERS; i += 1) {
    scheduledAt += exponentialInterval(AVG_INTERVAL_MS);
    const delay = scheduledAt;
    const product = products[Math.floor(Math.random() * products.length)];
    const buyer = buyers[Math.floor(Math.random() * buyers.length)];
    scheduledRuns.push(
      new Promise((resolve) => {
        setTimeout(async () => {
          try {
            resolve(await placeOneOrder(buyer, product));
          } catch (err) {
            resolve({ outcome: 'exception', error: err.message, ms: null });
          }
        }, delay);
      })
    );
  }

  const settled = await Promise.all(scheduledRuns);
  results.push(...settled);
  const wallClockMs = Date.now() - runStart;

  const byOutcome = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

  const latencies = results.filter((r) => typeof r.ms === 'number').map((r) => r.ms).sort((a, b) => a - b);

  console.log(`\nDone in ${(wallClockMs / 1000).toFixed(1)}s wall-clock for ${TOTAL_ORDERS} orders (avg observed rate: ${(TOTAL_ORDERS / (wallClockMs / 1000)).toFixed(2)}/s).`);
  console.log(`Outcomes: ${JSON.stringify(byOutcome)}`);
  console.log(
    `Checkout latency (ms) — p50=${percentile(latencies, 50)} p95=${percentile(latencies, 95)} p99=${percentile(latencies, 99)} max=${latencies[latencies.length - 1]}`
  );

  const successCount = byOutcome.success || 0;
  const errorCount = (byOutcome.error || 0) + (byOutcome.exception || 0) + (byOutcome.cart_failed || 0) + (byOutcome.draft_failed || 0);
  const successRate = ((successCount / TOTAL_ORDERS) * 100).toFixed(1);
  console.log(`Success rate: ${successCount}/${TOTAL_ORDERS} (${successRate}%). Unexpected errors (not clean 409s): ${errorCount}.`);

  if (errorCount > 0) {
    const sample = results.find((r) => ['error', 'exception', 'cart_failed', 'draft_failed'].includes(r.outcome));
    console.log('Sample failure:', JSON.stringify(sample));
  }

  // Data-integrity check, same standard as loadTestConcurrency.js: no
  // product should ever go negative, and total real orders per product
  // should equal the successful-outcome count for that product.
  console.log('\nVerifying data integrity across all products...');
  let integrityOk = true;
  for (const product of products) {
    // eslint-disable-next-line no-await-in-loop
    const final = await prisma.product.findUnique({ where: { id: product.id } });
    const expectedSuccesses = results.filter((r) => r.outcome === 'success' && r.productId === product.id).length;
    const expectedStock = PRODUCT_STOCK - expectedSuccesses;
    if (final.stock !== expectedStock || final.stock < 0) {
      integrityOk = false;
      console.log(`  MISMATCH on ${product.name}: stock=${final.stock}, expected=${expectedStock}`);
    }
  }
  console.log(integrityOk ? '  OK — every product\'s stock exactly matches its real successful order count, none negative.' : '  INTEGRITY FAILURE — see above.');

  const pass = errorCount === 0 && integrityOk;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = pass ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('Peak-hour simulation crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
