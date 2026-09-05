// tests/load/k6-realistic-mix.js
//
// Pattern 23 (realistic load and concurrency test) — replaces
// tests/load-test.js (a legacy single-hardcoded-user smoke script) as the
// actual pre-launch throughput/capacity test. Models an approximate
// storefront+admin traffic mix instead of one linear flow:
//
//   40% catalog/search reads     20% product detail
//   15% cart operations          10% address/checkout preparation
//    5% order-history/tracking    5% admin read traffic
//    5% transactional checkout/order operations
//
// Every identity is generated at runtime (a fresh OTP-login buyer per k6
// VU, never reused across VUs) and every product id is discovered at
// runtime via the real GET /api/products API — see
// tests/e2e-helpers/prepareLoadTestCatalog.js for the (idempotent, safe to
// rerun) catalog this discovers. Nothing is hardcoded the way the legacy
// script hardcoded a phone number, product id, and address id.
//
// Runs ONLY against the dedicated E2E backend + database — refuses to
// start otherwise (see the BASE_URL guard below), same convention as
// loadTestConcurrency.js / loadTestPeakHour.js.
//
// Usage (see package.json's e2e:load-test:realistic:* scripts):
//   node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=baseline tests/load/k6-realistic-mix.js
//   node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=peak     tests/load/k6-realistic-mix.js
//   node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=stress   tests/load/k6-realistic-mix.js
//   node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=spike    tests/load/k6-realistic-mix.js
//   node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=soak     tests/load/k6-realistic-mix.js
// (run-with-e2e-env.js loads .env.e2e into the process env, which is how
// ADMIN_EMAIL/ADMIN_PASSWORD/LOAD_TEST_API_URL reach k6's __ENV — k6 reads
// OS environment variables into __ENV automatically, no -e needed for
// those.) Requires `npm run e2e:mocks`, `npm run e2e:server`, and
// `node scripts/run-with-e2e-env.js node tests/e2e-helpers/prepareLoadTestCatalog.js`
// already running/done in separate terminals first.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.LOAD_TEST_API_URL || 'http://localhost:5001';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL;
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD;
const VALID_OTP = '123456';
const RUN_ID = `${Date.now().toString(36)}`;

// This script creates real users/orders/addresses against whatever
// LOAD_TEST_API_URL points at — refuse anything that isn't obviously the
// dedicated e2e server (default port 5001; the dev server is 5000).
if (/:5000(\/|$)/.test(BASE_URL) || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error(
    'Refusing to run: LOAD_TEST_API_URL looks like the dev server (port 5000) or ADMIN_EMAIL/ADMIN_PASSWORD are unset. ' +
      'Run via: node scripts/run-with-e2e-env.js k6 run -e LOAD_PROFILE=<name> tests/load/k6-realistic-mix.js ' +
      '(after npm run e2e:mocks and npm run e2e:server are already running).'
  );
}

// --- Load profiles (Pattern 23's 5 scenarios) ------------------------------
// Scaled down from the pattern's full spec (10-15min/30min/30min/60min,
// spike to 200) for a single dev laptop against a shared/free-tier Atlas
// cluster — see this session's own record for why. LOAD_SCALE lets any
// profile be stretched back toward the full spec later
// (LOAD_SCALE=6 roughly restores baseline/peak/stress to their original
// duration) without editing this file.
const SCALE = Number(__ENV.LOAD_SCALE) || 1;
const PROFILES = {
  baseline: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '30s', target: 20 },
    { duration: `${Math.round(4 * SCALE)}m`, target: 20 },
    { duration: '15s', target: 0 },
  ] },
  peak: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '30s', target: 50 },
    { duration: `${Math.round(5 * SCALE)}m`, target: 50 },
    { duration: '15s', target: 0 },
  ] },
  stress: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '45s', target: 100 },
    { duration: `${Math.round(5 * SCALE)}m`, target: 100 },
    { duration: '15s', target: 0 },
  ] },
  spike: { executor: 'ramping-vus', startVUs: 20, stages: [
    { duration: '20s', target: 20 },
    { duration: '20s', target: 100 }, // capped well below the full 200 spec — see this session's record
    { duration: `${Math.round(90 * SCALE)}s`, target: 100 },
    { duration: '20s', target: 20 },
    { duration: '20s', target: 0 },
  ] },
  soak: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '30s', target: 50 },
    { duration: `${Math.round(9 * SCALE)}m`, target: 50 },
    { duration: '15s', target: 0 },
  ] },
};

const profileName = __ENV.LOAD_PROFILE || 'baseline';
const profile = PROFILES[profileName];
if (!profile) {
  throw new Error(`Unknown LOAD_PROFILE "${profileName}" — expected one of: ${Object.keys(PROFILES).join(', ')}`);
}

export const options = {
  scenarios: { [profileName]: profile },
  // Pattern 23's acceptance gates. Tagged per-request below so 'normal' vs
  // 'transactional' endpoints are judged against their own bar. None of
  // these set abortOnFail, so a breach only shows up as a failed threshold
  // in the end-of-run summary — it never cuts a run short. That's
  // deliberate: stress/spike are explicitly meant to probe past the point
  // where normal-endpoint latency degrades, and the point of running them
  // is to see and record the full shape of that degradation, not stop the
  // instant the p95<500ms bar is first crossed.
  thresholds: {
    'http_req_duration{endpoint_class:normal}': ['p(95)<500'],
    'http_req_duration{endpoint_class:transactional}': ['p(95)<1000'],
    http_req_failed: ['rate<0.005'],
    checkout_critical_failures: ['count==0'],
  },
};

// --- Custom metrics (Pattern 23's required report fields) ------------------
const catalogTrend = new Trend('catalog_read_duration', true);
const pdpTrend = new Trend('product_detail_duration', true);
const cartTrend = new Trend('cart_ops_duration', true);
const checkoutPrepTrend = new Trend('checkout_prep_duration', true);
const orderHistoryTrend = new Trend('order_history_duration', true);
const adminReadTrend = new Trend('admin_read_duration', true);
const transactionalTrend = new Trend('transactional_checkout_duration', true);
const checkoutCriticalFailures = new Counter('checkout_critical_failures');
const bucketCounter = new Counter('bucket_iterations');

// --- Shared setup (runs once, not per-VU) -----------------------------------
// Discovers real product ids at runtime and logs in as the seeded e2e
// admin ONCE (admin login is rate-limited — see rateLimiter.js's
// adminLoginRateLimiter — so every VU doing its own admin login would
// itself trip that limiter and pollute the results with 429s that have
// nothing to do with the traffic mix being measured).
export function setup() {
  // limit=100 is paginateWithCache's own hard MAX_LIMIT cap — discovering
  // as much of the prepared pool as the API allows in one page spreads
  // concurrent draft-order creation across as many distinct product
  // documents as possible, which matters: too small a discovered pool
  // relative to VU count concentrates many concurrent transactions onto
  // the same few documents, tripping withTransactionRetry.js's genuine
  // same-document contention handling far more often than any real
  // storefront's traffic (spread across a real catalog) would.
  const catalogRes = http.get(`${BASE_URL}/api/products?search=LoadTestCatalog&limit=100`);
  const txnPoolRes = http.get(`${BASE_URL}/api/products?search=LoadTestTxnPool&limit=100`);
  const catalogIds = (catalogRes.json('data') || []).map((p) => p.id);
  const txnPoolIds = (txnPoolRes.json('data') || []).map((p) => p.id);

  if (catalogIds.length === 0 || txnPoolIds.length === 0) {
    throw new Error(
      'No load-test catalog found — run `node scripts/run-with-e2e-env.js node tests/e2e-helpers/prepareLoadTestCatalog.js` first.'
    );
  }

  const adminLogin = http.post(
    `${BASE_URL}/api/admin/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  const adminToken = adminLogin.json('data.token');
  if (!adminToken) {
    throw new Error(`Admin login failed in setup(): ${adminLogin.body}`);
  }

  return { catalogIds, txnPoolIds, adminToken };
}

// --- tiny request helper: tags every call with an endpoint_class for the
// per-class thresholds above, and a bucket name for readable summaries.
// `expectedStatuses` overrides k6's default "any non-2xx counts as a
// failure" classification for calls where a non-2xx is itself the correct,
// intended application response (e.g. GET /api/orders legitimately 404s
// for a buyer who's never started a checkout) — without it, every one of
// those would inflate http_req_failed with noise that has nothing to do
// with the app actually failing. ---
function req(method, path, { body, token, tags, expectedStatuses } = {}) {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    tags,
    ...(expectedStatuses ? { responseCallback: http.expectedStatuses(...expectedStatuses) } : {}),
  };
  return method === 'GET'
    ? http.get(`${BASE_URL}${path}`, params)
    : http.request(method, `${BASE_URL}${path}`, body ? JSON.stringify(body) : undefined, params);
}

// Per-VU phone numbering, offset by wall-clock run start (same collision
// -avoidance reasoning as loadTestConcurrency.js's freshPhone) plus the VU
// id, so two VUs never generate the same number even in the same
// millisecond.
function freshPhone(vuId, seq) {
  const base = 700000000 + (Date.now() % 90000000);
  return `9${String(base + vuId * 100000 + seq).padStart(9, '0')}`;
}

// --- Per-VU session state ---------------------------------------------------
// A real customer doesn't re-authenticate on every click — this VU logs
// its browsing/cart/checkout-prep/order-history buyer in ONCE (lazily, on
// first need) and reuses that session for the rest of its iterations,
// which is both more realistic and far lighter on the OTP path than
// re-logging-in every iteration would be.
let session = null;
let phoneSeq = 0;

function ensureSession(vuId) {
  if (session) return session;
  phoneSeq += 1;
  const phone = `+91${freshPhone(vuId, phoneSeq)}`;
  req('POST', '/api/otp/send-otp', { body: { phone } });
  const verify = req('POST', '/api/otp/verify-otp', { body: { phone, otp: VALID_OTP } });
  const token = verify.json('data.token');
  if (!token) return null; // caller checks/handles a null session gracefully
  session = { token, addressId: null };
  return session;
}

function ensureAddress(vuId) {
  const s = ensureSession(vuId);
  if (!s || s.addressId) return s;
  const address = req('POST', '/api/user/address', {
    token: s.token,
    tags: { endpoint_class: 'normal', bucket: 'checkout_prep' },
    body: {
      name: 'Realistic Load Test Buyer',
      phone: `+91${freshPhone(vuId, phoneSeq)}`,
      pincode: '411001',
      city: 'Pune',
      state: 'Maharashtra',
      houseArea: '1 Load Test Lane',
      area: 'Kothrud',
    },
  });
  s.addressId = address.json('data.id') || null;
  return s;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Traffic buckets ---------------------------------------------------------
const SEARCH_TERMS = ['battery', 'light', 'cover', 'mat', 'mirror', 'wiper'];
const CATEGORIES = ['Rubber & Matting', 'Lighting', 'Electrical', 'Seat Covers', 'Mirrors'];

function catalogSearchBucket() {
  const started = Date.now();
  const roll = Math.random();
  let res;
  if (roll < 0.35) {
    res = req('GET', `/api/products?page=${1 + Math.floor(Math.random() * 3)}&limit=12`, { tags: { endpoint_class: 'normal', bucket: 'catalog' } });
  } else if (roll < 0.6) {
    res = req('GET', `/api/products?search=${pick(SEARCH_TERMS)}&limit=12`, { tags: { endpoint_class: 'normal', bucket: 'catalog' } });
  } else if (roll < 0.8) {
    res = req('GET', `/api/products?category=${encodeURIComponent(pick(CATEGORIES))}&limit=12`, { tags: { endpoint_class: 'normal', bucket: 'catalog' } });
  } else if (roll < 0.9) {
    res = req('GET', '/api/homepage/new-arrivals', { tags: { endpoint_class: 'normal', bucket: 'catalog' } });
  } else {
    res = req('GET', '/api/homepage/banners', { tags: { endpoint_class: 'normal', bucket: 'catalog' } });
  }
  check(res, { 'catalog read OK': (r) => r.status === 200 });
  catalogTrend.add(Date.now() - started);
}

function productDetailBucket(data) {
  const started = Date.now();
  const id = pick(data.catalogIds);
  const detail = req('GET', `/api/products/${id}`, { tags: { endpoint_class: 'normal', bucket: 'product_detail' } });
  check(detail, { 'product detail OK': (r) => r.status === 200 });
  if (Math.random() < 0.5) {
    req('GET', `/api/products/${id}/related`, { tags: { endpoint_class: 'normal', bucket: 'product_detail' } });
  }
  pdpTrend.add(Date.now() - started);
}

function cartOpsBucket(data, vuId) {
  const started = Date.now();
  const s = ensureSession(vuId);
  if (!s) return;
  const productId = pick(data.catalogIds);
  const add = req('PUT', '/api/cart', {
    token: s.token,
    body: { productId, quantity: 1 + Math.floor(Math.random() * 2) },
    tags: { endpoint_class: 'normal', bucket: 'cart' },
  });
  check(add, { 'cart add OK': (r) => r.status === 200 });
  req('GET', '/api/cart', { token: s.token, tags: { endpoint_class: 'normal', bucket: 'cart' } });
  cartTrend.add(Date.now() - started);
}

function checkoutPrepBucket(data, vuId) {
  const started = Date.now();
  const s = ensureAddress(vuId);
  if (!s || !s.addressId) return;
  req('POST', '/api/shipping/serviceability', {
    body: { pincode: '411001' },
    tags: { endpoint_class: 'normal', bucket: 'checkout_prep' },
  });
  req('PUT', '/api/cart', {
    token: s.token,
    body: { productId: pick(data.catalogIds), quantity: 1 },
    tags: { endpoint_class: 'normal', bucket: 'checkout_prep' },
  });
  const draft = req('POST', '/api/orders', {
    token: s.token,
    body: { selectedAddressId: s.addressId },
    tags: { endpoint_class: 'normal', bucket: 'checkout_prep' },
  });
  check(draft, { 'draft order OK': (r) => r.status === 201 });
  checkoutPrepTrend.add(Date.now() - started);
}

function orderHistoryBucket(vuId) {
  const started = Date.now();
  const s = ensureSession(vuId);
  if (!s) return;
  // GET /api/orders returns the buyer's in-progress draft order — a 404
  // ("no draft order found") is the correct, expected response for a
  // browsing/cart-only buyer who has never reached checkout, not an error.
  req('GET', '/api/orders', {
    token: s.token,
    tags: { endpoint_class: 'normal', bucket: 'order_history' },
    expectedStatuses: [200, 404],
  });
  req('GET', '/api/orders/history', { token: s.token, tags: { endpoint_class: 'normal', bucket: 'order_history' } });
  orderHistoryTrend.add(Date.now() - started);
}

function adminReadBucket(data) {
  const started = Date.now();
  const token = data.adminToken;
  req('GET', '/api/admin/stats', { token, tags: { endpoint_class: 'normal', bucket: 'admin_read' } });
  req('GET', '/api/admin/alerts', { token, tags: { endpoint_class: 'normal', bucket: 'admin_read' } });
  req('GET', '/api/orders/all?limit=20', { token, tags: { endpoint_class: 'normal', bucket: 'admin_read' } });
  adminReadTrend.add(Date.now() - started);
}

// The one bucket that genuinely mutates authoritative order/stock state —
// a fresh buyer and address every time (real distinct customers, not one
// VU repeatedly reordering), drawing from the dedicated high-stock
// LoadTestTxnPool so a long run's real stock decrements never legitimately
// exhaust it and pollute the error rate with expected (not capacity-
// related) 409s.
function transactionalCheckoutBucket(data, vuId) {
  const started = Date.now();
  phoneSeq += 1;
  const phone = `+91${freshPhone(vuId, phoneSeq)}`;
  req('POST', '/api/otp/send-otp', { body: { phone } });
  const verify = req('POST', '/api/otp/verify-otp', { body: { phone, otp: VALID_OTP } });
  const token = verify.json('data.token');
  if (!token) return;

  const address = req('POST', '/api/user/address', {
    token,
    tags: { endpoint_class: 'normal', bucket: 'transactional' },
    body: {
      name: 'Realistic Load Test Buyer',
      phone: `+91${freshPhone(vuId, phoneSeq + 1000)}`,
      pincode: '411001',
      city: 'Pune',
      state: 'Maharashtra',
      houseArea: '1 Load Test Lane',
      area: 'Kothrud',
    },
  });
  const addressId = address.json('data.id');
  if (!addressId) return;

  const productId = pick(data.txnPoolIds);
  req('PUT', '/api/cart', { token, body: { productId, quantity: 1 }, tags: { endpoint_class: 'normal', bucket: 'transactional' } });
  const draft = req('POST', '/api/orders', { token, body: { selectedAddressId: addressId }, tags: { endpoint_class: 'normal', bucket: 'transactional' } });
  const orderId = draft.json('data.id');
  if (!orderId) {
    checkoutCriticalFailures.add(1);
    return;
  }

  const cod = req('POST', '/api/payment/cod', {
    token,
    body: { orderId, method: 'cod' },
    tags: { endpoint_class: 'transactional', bucket: 'transactional' },
  });
  const ok = check(cod, { 'COD placement OK': (r) => r.status === 200 });
  if (!ok) {
    // A 409 here is a genuine anomaly (the txn pool is provisioned with
    // thousands of units specifically so this shouldn't happen under a
    // scaled-down profile) — counted separately from the generic error
    // rate so it stands out in the summary rather than blending into
    // ordinary 4xx noise.
    checkoutCriticalFailures.add(1);
  }
  transactionalTrend.add(Date.now() - started);
}

// --- VU entry point: weighted random bucket selection -----------------------
export default function (data) {
  const vuId = __VU;
  const roll = Math.random();

  if (roll < 0.40) {
    bucketCounter.add(1, { bucket: 'catalog' });
    catalogSearchBucket();
  } else if (roll < 0.60) {
    bucketCounter.add(1, { bucket: 'product_detail' });
    productDetailBucket(data);
  } else if (roll < 0.75) {
    bucketCounter.add(1, { bucket: 'cart' });
    cartOpsBucket(data, vuId);
  } else if (roll < 0.85) {
    bucketCounter.add(1, { bucket: 'checkout_prep' });
    checkoutPrepBucket(data, vuId);
  } else if (roll < 0.90) {
    bucketCounter.add(1, { bucket: 'order_history' });
    orderHistoryBucket(vuId);
  } else if (roll < 0.95) {
    bucketCounter.add(1, { bucket: 'admin_read' });
    adminReadBucket(data);
  } else {
    bucketCounter.add(1, { bucket: 'transactional' });
    transactionalCheckoutBucket(data, vuId);
  }

  // Real users pause between actions — without this every VU would hammer
  // the server back-to-back with zero think time, which inflates
  // concurrency far beyond what "N concurrent users" is meant to model.
  sleep(1 + Math.random() * 2);
}
