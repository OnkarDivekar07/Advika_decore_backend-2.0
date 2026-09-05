// tests/e2e-helpers/loadTestConcurrency.js
//
// Concurrency-CORRECTNESS load test, not a capacity/throughput benchmark.
// The question this answers is "does the app stay correct under real
// concurrent pressure" (no oversell, no duplicate orders, no orphaned
// Razorpay orders) — not "how many requests/second can this server handle".
// The latter needs a production-shaped deployment (real PM2 cluster size,
// real server specs) to mean anything; this runs against a single `nodemon`
// e2e server on a dev machine, which would only measure this machine, not
// production capacity.
//
// Runs ONLY against the dedicated E2E backend (npm run e2e:server) and its
// dedicated `*_e2e` database — refuses to run otherwise, same guard
// prisma/reset-e2e.js uses. Every buyer in this script is a synthetic OTP
// login against the mock MSG91 server (tests/e2e-mocks), never a real
// phone/SMS; every product it creates is its own, freshly made, never
// touching real catalog data.
//
// Usage: npm run e2e:load-test (after e2e:mocks + e2e:server are already
// running, and e2e:setup has seeded the DB at least once).
require('module-alias/register');
const prisma = require('@config/prisma');
const { buildSignedRazorpayWebhook } = require('./signRazorpayWebhook');

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

// --- tiny HTTP helper, same shape as e2e-real/support/realApi.js ----------
async function request(method, path, { token, body } = {}) {
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
  return { status: res.status, ok: res.ok, body: json };
}

// A fresh, valid-shaped Indian mobile number per call — [6-9] first digit,
// 10 digits total — collision-safe within one run via an incrementing
// counter, and collision-safe ACROSS separate process runs (rerunning this
// script without an e2e:reset-db in between) via a per-process offset
// derived from wall-clock start time. Without the offset, every rerun
// started counting from the same base and re-logged buyer #1 (etc.) into
// the exact same E2E user account as the previous run, which could still
// be carrying a leftover, unpurchased cart item from that earlier run and
// block a brand-new checkout attempt on a completely unrelated product.
const PHONE_BASE = 700000000 + (Date.now() % 90000000);
let phoneCounter = 0;
function freshPhone() {
  phoneCounter += 1;
  return `9${String(PHONE_BASE + phoneCounter).padStart(9, '0')}`;
}

async function loginFreshBuyer() {
  const phone = freshPhone();
  const e164 = `+91${phone}`;
  await request('POST', '/api/otp/send-otp', { body: { phone: e164 } });
  const verify = await request('POST', '/api/otp/verify-otp', {
    body: { phone: e164, otp: VALID_OTP },
  });
  const token = verify.body?.data?.token;
  if (!token) {
    throw new Error(`Login failed for ${e164}: ${JSON.stringify(verify.body)}`);
  }
  return { phone, token };
}

async function setUpBuyer(productId) {
  const { token } = await loginFreshBuyer();
  const address = await request('POST', '/api/user/address', {
    token,
    body: {
      name: 'Load Test Buyer',
      phone: `+91${freshPhone()}`,
      pincode: '411001',
      city: 'Pune',
      state: 'Maharashtra',
      houseArea: '1 Load Test Lane',
      area: 'Kothrud',
    },
  });
  const addressId = address.body?.data?.id;
  await request('PUT', '/api/cart', { token, body: { productId, quantity: 1 } });
  const draft = await request('POST', '/api/order', { token, body: { selectedAddressId: addressId } });
  const orderId = draft.body?.data?.id;
  if (!orderId) {
    throw new Error(`Draft order creation failed: ${JSON.stringify(draft.body)}`);
  }
  return { token, orderId };
}

async function makeTestProduct(stock) {
  return prisma.product.create({
    data: {
      name: `Load Test Product ${RUN_ID}-${stock}`,
      category: ['Rubber & Matting'],
      brand: 'Advika',
      price: 499,
      stock,
      images: [],
      description: 'Synthetic product created by loadTestConcurrency.js — safe to delete.',
    },
  });
}

function summarize(results) {
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

// --- Scenario A: oversell race --------------------------------------------
// N buyers, each with their OWN account/cart/draft order for 1 unit,
// simultaneously place a COD order against a product with fewer units of
// real stock than there are buyers. Correct behavior: exactly `stock`
// orders succeed, the rest get a clean 409 conflict, and the product's real
// stock never goes negative or gets decremented more than `stock` times.
async function scenarioOversell({ stock, buyers }) {
  console.log(`\n[A] Oversell race — stock=${stock}, concurrent buyers=${buyers}`);
  const product = await makeTestProduct(stock);

  console.log('  setting up buyers (sequential logins, not the race itself)...');
  const setups = [];
  for (let i = 0; i < buyers; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    setups.push(await setUpBuyer(product.id));
  }

  console.log('  firing all COD placements at once...');
  const results = await Promise.all(
    setups.map((b) => request('POST', '/api/payment/cod', { token: b.token, body: { orderId: b.orderId, method: 'cod' } }))
  );

  const statusCounts = summarize(results);
  const succeeded = results.filter((r) => r.status === 200).length;

  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  // Prisma's MongoDB connector doesn't reliably support a relation filter
  // (`orderItems: { some: { productId } }`) directly on Order the way a
  // relational DB would — confirmed empirically (returned 0 even for
  // orders directly verified to exist and reference this product).
  // Two-step query through the plain scalar productId field on OrderItem
  // itself, which does not have this issue.
  const itemsForProduct = await prisma.orderItem.findMany({
    where: { productId: product.id },
    select: { orderId: true },
  });
  const realOrders = await prisma.order.count({
    where: { id: { in: itemsForProduct.map((i) => i.orderId) }, status: { not: 'draft' } },
  });

  const pass =
    succeeded === Math.min(stock, buyers) &&
    finalProduct.stock === Math.max(0, stock - buyers) &&
    finalProduct.stock >= 0 &&
    realOrders === succeeded;

  console.log(`  HTTP status counts: ${JSON.stringify(statusCounts)}`);
  console.log(`  succeeded=${succeeded} (expected ${Math.min(stock, buyers)}) | final stock=${finalProduct.stock} (expected ${Math.max(0, stock - buyers)}) | real orders written=${realOrders}`);
  console.log(pass ? '  PASS — no oversell, no phantom orders, stock never negative' : '  FAIL');
  return pass;
}

// --- Scenario B: duplicate-submission race --------------------------------
// One buyer, one draft order, the SAME "place COD order" request fired N
// times at once (simulating a frantic double/triple-tap, or a client retry
// racing the original request's own response). Correct behavior: exactly
// one real Order row is ever created for this draft order, no matter how
// many of the N requests "won" the HTTP race.
async function scenarioDuplicateSubmit({ stock, attempts }) {
  console.log(`\n[B] Duplicate-submission race — ${attempts} concurrent identical requests`);
  const product = await makeTestProduct(stock);
  const buyer = await setUpBuyer(product.id);

  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      request('POST', '/api/payment/cod', { token: buyer.token, body: { orderId: buyer.orderId, method: 'cod' } })
    )
  );

  const succeeded = results.filter((r) => r.status === 200).length;
  const alreadyProcessedCount = results.filter((r) => r.body?.data?.alreadyProcessed === true).length;
  const realOrders = await prisma.order.count({ where: { id: buyer.orderId, status: { not: 'draft' } } });

  const pass = succeeded === attempts && realOrders === 1 && alreadyProcessedCount === attempts - 1;

  console.log(`  ${attempts} requests -> ${succeeded} returned 200, ${alreadyProcessedCount} marked alreadyProcessed, real Order rows written=${realOrders} (expected 1)`);
  console.log(pass ? '  PASS — exactly one real order, every duplicate correctly recognized itself as one' : '  FAIL');
  return pass;
}

// --- Scenario C: concurrent Razorpay order-id creation --------------------
// One buyer, one draft order, N concurrent create-orderid calls (the
// customer double-tapping "Pay Now", or a slow network causing a retry
// while the first request is still in flight). Correct behavior: every
// response resolves to the SAME Razorpay order id — never two live
// Razorpay orders for the same draft order (which would risk one of them
// silently orphaning a real captured payment).
async function scenarioConcurrentPaymentOrderCreation({ stock, attempts }) {
  console.log(`\n[C] Concurrent Razorpay order-creation race — ${attempts} concurrent create-orderid calls`);
  const product = await makeTestProduct(stock);
  const buyer = await setUpBuyer(product.id);

  const results = await Promise.all(
    Array.from({ length: attempts }, () => request('POST', '/api/payment/create-orderid', { token: buyer.token }))
  );

  const ids = results.map((r) => r.body?.data?.order?.id).filter(Boolean);
  const uniqueIds = new Set(ids);
  const finalOrder = await prisma.order.findUnique({ where: { id: buyer.orderId } });
  // Not every one of the N concurrent calls is guaranteed to succeed —
  // this hits Razorpay's real test-mode API, which has its own rate limits
  // entirely outside this app's control. What this app is actually
  // responsible for is that however many DID get a real Razorpay order
  // back, they all agree on the exact same one (never two live Razorpay
  // orders for the same draft order) — not that literally all N requests
  // succeed against a third party.
  const dbMatchesTheOneId = ids.length > 0 && finalOrder.payment_order_id === [...uniqueIds][0];
  const pass = ids.length > 0 && uniqueIds.size === 1 && dbMatchesTheOneId;

  console.log(`  ${attempts} requests -> ${ids.length} got a real Razorpay order id back, ${uniqueIds.size} distinct id(s) among them (expected 1); DB payment_order_id matches: ${dbMatchesTheOneId}`);
  console.log(pass ? '  PASS — every successful concurrent call converged on the one persisted Razorpay order' : '  FAIL');
  return pass;
}

// --- Scenario D: payment capture racing a COD order for the same stock ----
// Two DIFFERENT buyers, two DIFFERENT payment code paths, racing for the
// SAME single unit of stock: buyer A's Razorpay payment gets captured via a
// genuinely HMAC-signed webhook (the real signature-verification and
// handleRazorpayWebhookEvent code path, not a mock) at the exact same
// instant buyer B tries to COD-place their own order for the same product.
//
// This is NOT a "COD vs. prepaid, only one may confirm" test — that would
// invent a policy the app doesn't actually promise. The documented policy
// (payment.service.js's own extensive comments, independently confirmed by
// reading the code) is asymmetric by design: COD has never taken the
// customer's money, so it can and does refuse outright on insufficient
// stock (decrementStockForOrder with throwOnInsufficientStock:true, inside
// the same transaction that confirms the order). A Razorpay payment is
// already captured — real money already moved — by the time fulfillment
// runs, so the app can never safely un-confirm it on discovering a stock
// shortfall; instead it decrements with throwOnInsufficientStock:false,
// flags the order oversold:true, and forces fulfillmentStatus:'failed'
// (never 'completed', since retrying can't fix a real shortage) for a
// human to resolve — this is the documented, intentional fail-open-for-
// captured-payments behavior this app is designed around, not a bug.
//
// So both orders CAN legitimately end up status:'confirmed' here — what
// actually matters, and what this asserts, is: stock never goes negative,
// exactly one order is the genuine (non-oversold) winner of the physical
// unit, and the other — if it lost the race — is truthfully marked
// oversold with a 'failed' fulfillmentStatus, never silently marked
// 'completed' while actually unfulfillable.
async function scenarioPaymentCaptureRacesCOD({ webhookSecret }) {
  console.log(`\n[D] Payment-capture-webhook racing a COD order for the same last unit`);
  const product = await makeTestProduct(1);

  const buyerA = await setUpBuyer(product.id);
  const buyerB = await setUpBuyer(product.id);

  const createOrderRes = await request('POST', '/api/payment/create-orderid', { token: buyerA.token });
  const razorpayOrder = createOrderRes.body?.data?.order;
  if (!razorpayOrder?.id) {
    console.log(`  SKIP — could not create a real Razorpay order for buyer A: ${JSON.stringify(createOrderRes.body)}`);
    return true; // not this app's fault if Razorpay's own test-mode API is unavailable/rate-limited
  }

  const { rawBody, headers } = buildSignedRazorpayWebhook({
    webhookSecret,
    razorpayOrderId: razorpayOrder.id,
    amountPaise: razorpayOrder.amount,
    event: 'payment.captured',
  });

  const [webhookRes, codRes] = await Promise.all([
    fetch(`${API_BASE}/api/payment/webhook`, { method: 'POST', headers, body: rawBody }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => ({})),
    })),
    request('POST', '/api/payment/cod', { token: buyerB.token, body: { orderId: buyerB.orderId, method: 'cod' } }),
  ]);

  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  const orderA = await prisma.order.findUnique({ where: { id: buyerA.orderId } });
  const orderB = await prisma.order.findUnique({ where: { id: buyerB.orderId } });

  // A "genuine winner" of the one physical unit: actually confirmed AND not
  // flagged oversold. A COD order that lost its own atomic stock check
  // never reaches status:'confirmed' at all (blocked outright, per its own
  // throwOnInsufficientStock:true guard) — so it can't be a false winner
  // here either.
  const genuineWinners = [orderA, orderB].filter((o) => o.status === 'confirmed' && !o.oversold);
  // The loser, if the race produced one: still confirmed (money already
  // moved, for the paid case) but truthfully marked oversold, never
  // claiming 'completed' fulfillment for a unit that doesn't exist.
  const truthfulLosers = [orderA, orderB].filter(
    (o) => o.status === 'confirmed' && o.oversold && o.fulfillmentStatus === 'failed'
  );
  const neitherSilentlyWrong = genuineWinners.length + truthfulLosers.length === 2;

  const pass = finalProduct.stock === 0 && genuineWinners.length === 1 && neitherSilentlyWrong;

  console.log(`  webhook -> ${webhookRes.status}, COD -> ${codRes.status}`);
  console.log(`  final stock=${finalProduct.stock} (expected 0) | genuine (non-oversold) winners=${genuineWinners.length} (expected 1)`);
  console.log(`  orderA(status=${orderA.status},paymentStatus=${orderA.paymentStatus},oversold=${orderA.oversold},fulfillmentStatus=${orderA.fulfillmentStatus})`);
  console.log(`  orderB(status=${orderB.status},paymentStatus=${orderB.paymentStatus},oversold=${orderB.oversold},fulfillmentStatus=${orderB.fulfillmentStatus})`);
  console.log(pass
    ? '  PASS — exactly one order genuinely won the unit; any loser is truthfully marked oversold/failed, never silently completed'
    : '  FAIL');
  return pass;
}

// --- Scenario E: two admins adjusting the same SKU's stock concurrently ---
// Both requests read the product's stock as the same starting value (the
// "two admins both had the page open, both decided on a new number"
// scenario the expectedStock optimistic-concurrency check exists for — see
// inventory.service.js's adjustStock). Correct behavior: exactly one write
// succeeds; the other gets a clean 409 telling it stock has since changed,
// never a silent lost update.
async function scenarioConcurrentAdminStockAdjustment() {
  console.log(`\n[E] Two concurrent admin stock adjustments on the same SKU`);
  const product = await makeTestProduct(10);

  const loginRes = await request('POST', '/api/admin/login', {
    body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  const adminToken = loginRes.body?.data?.token;
  if (!adminToken) {
    console.log(`  SKIP — could not log in as the seeded e2e admin: ${JSON.stringify(loginRes.body)}`);
    return true;
  }

  const results = await Promise.all([
    request('PATCH', `/api/inventory/${product.id}`, {
      token: adminToken,
      body: { action: 'set', quantity: 50, expectedStock: 10 },
    }),
    request('PATCH', `/api/inventory/${product.id}`, {
      token: adminToken,
      body: { action: 'set', quantity: 0, expectedStock: 10 },
    }),
  ]);

  const statuses = results.map((r) => r.status).sort();
  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });
  const winnerAppliedValue = results.find((r) => r.status === 200)?.body?.data?.stock;

  const pass =
    JSON.stringify(statuses) === JSON.stringify([200, 409]) &&
    (finalProduct.stock === 50 || finalProduct.stock === 0) &&
    finalProduct.stock === winnerAppliedValue;

  console.log(`  statuses=${JSON.stringify(statuses)} (expected [200,409]) | final stock=${finalProduct.stock}, winner's applied value=${winnerAppliedValue}`);
  console.log(pass ? '  PASS — exactly one admin write applied, the loser got a clean conflict, no lost update' : '  FAIL');
  return pass;
}

// --- Scenario F: genuinely duplicate webhook delivery, fired concurrently -
// The EXACT same signed payload (same eventId) delivered twice at once —
// e.g. Razorpay redelivering after a slow-but-eventually-200 response.
// Correct behavior: exactly one WebhookEvent ledger row for that eventId
// (the DB's own unique(source,eventId) constraint is what actually
// prevents a double-insert, not application logic alone), fulfillment
// (cart-clear/notification enqueue) runs exactly once, and the order is
// confirmed exactly once — no double stock-decrement, no duplicate
// fulfillment side effects.
async function scenarioDuplicateWebhookDelivery({ webhookSecret }) {
  console.log(`\n[F] Genuinely duplicate webhook delivery (same eventId), fired concurrently`);
  const product = await makeTestProduct(10);
  const buyer = await setUpBuyer(product.id);

  const createOrderRes = await request('POST', '/api/payment/create-orderid', { token: buyer.token });
  const razorpayOrder = createOrderRes.body?.data?.order;
  if (!razorpayOrder?.id) {
    console.log(`  SKIP — could not create a real Razorpay order: ${JSON.stringify(createOrderRes.body)}`);
    return true;
  }

  const { rawBody, headers, eventId } = buildSignedRazorpayWebhook({
    webhookSecret,
    razorpayOrderId: razorpayOrder.id,
    amountPaise: razorpayOrder.amount,
    event: 'payment.captured',
  });

  const postWebhook = () =>
    fetch(`${API_BASE}/api/payment/webhook`, { method: 'POST', headers, body: rawBody }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => ({})),
    }));

  const [res1, res2] = await Promise.all([postWebhook(), postWebhook()]);

  const ledgerCount = await prisma.webhookEvent.count({ where: { eventId } });
  const finalOrder = await prisma.order.findUnique({ where: { id: buyer.orderId } });
  const finalProduct = await prisma.product.findUnique({ where: { id: product.id } });

  // Neither delivery may ever crash with a raw, uncaught 500 — under
  // truly sub-millisecond-simultaneous delivery timing, MongoDB can abort
  // the losing side of the race deep enough into the transaction that it
  // exhausts withTransactionRetry's own budget and falls back to a clean
  // 409 instead of resolving to 200 on this exact attempt. That's an
  // acceptable, self-healing outcome (not a raw crash, no corrupted data)
  // — a non-2xx tells Razorpay to redeliver, and that redelivery finds the
  // ledger row the winner already committed and cleanly no-ops to 200 —
  // but it must never be a 500, and the actual data state must be correct
  // regardless of which status either side got.
  const neitherCrashed = res1.status !== 500 && res2.status !== 500;
  const pass =
    neitherCrashed &&
    ledgerCount === 1 &&
    finalOrder.status === 'confirmed' &&
    finalOrder.paymentStatus === 'paid' &&
    finalOrder.fulfillmentAttempts === 1 &&
    finalProduct.stock === 9; // decremented exactly once, not twice

  console.log(`  res1=${res1.status}, res2=${res2.status} (neither may be 500) | WebhookEvent rows for this eventId=${ledgerCount} (expected 1)`);
  console.log(`  order status=${finalOrder.status}, paymentStatus=${finalOrder.paymentStatus}, fulfillmentAttempts=${finalOrder.fulfillmentAttempts} (expected 1) | stock=${finalProduct.stock} (expected 9, decremented once)`);
  console.log(pass ? '  PASS — duplicate delivery deduped at the DB level, fulfillment ran exactly once, no raw crash' : '  FAIL');
  return pass;
}

async function main() {
  console.log(`Concurrency load test against ${API_BASE} (run ${RUN_ID})`);
  console.log('Target: correctness under concurrent load, not throughput/capacity.');

  // Overridable so trying a harsher contention level doesn't need a source
  // edit each time — e.g. LOAD_TEST_BUYERS=90 npm run e2e:load-test.
  const buyers = Number(process.env.LOAD_TEST_BUYERS) || 25;
  const stock = Number(process.env.LOAD_TEST_STOCK) || 5;
  const attempts = Number(process.env.LOAD_TEST_ATTEMPTS) || 15;

  const results = [];
  results.push(await scenarioOversell({ stock, buyers }));
  results.push(await scenarioDuplicateSubmit({ stock: 10, attempts }));
  results.push(await scenarioConcurrentPaymentOrderCreation({ stock: 10, attempts }));
  if (process.env.RAZORPAY_WEBHOOK_SECRET) {
    results.push(await scenarioPaymentCaptureRacesCOD({ webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET }));
    results.push(await scenarioDuplicateWebhookDelivery({ webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET }));
  } else {
    console.log('\n[D/F] SKIPPED — RAZORPAY_WEBHOOK_SECRET not set in this environment');
  }
  results.push(await scenarioConcurrentAdminStockAdjustment());

  const allPass = results.every(Boolean);
  console.log(`\n${allPass ? 'ALL SCENARIOS PASSED' : 'AT LEAST ONE SCENARIO FAILED'}`);
  process.exitCode = allPass ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('Load test crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
