// tests/e2e-helpers/fulfillmentSweepRecovery.js
//
// Pattern 16 (Redis/BullMQ/background-job resilience audit): live proof
// that fulfillmentReconciliationWorker.js's sweep — the actual retry
// mechanism behind payment.service.js's runFulfillment, per that
// function's own docstring — really does pick up and heal a 'failed'
// order against the real Redis/BullMQ/worker stack, not just in a mocked
// unit test. jobs/index.js's FULFILLMENT_RECONCILIATION_INTERVAL_MS
// comment already claimed a test like this existed
// ("e2e-real/fulfillment-sweep-recovery.spec.js") — it didn't; this is
// that test, finally built, as a plain script rather than a Playwright
// spec since it needs nothing browser-side, only direct DB seeding of the
// failure state (reliably forcing a genuine Redis outage at the exact
// instant runFulfillment enqueues a job isn't practical to time from a
// black-box test) plus polling the real API/DB for recovery.
//
// Runs ONLY against the dedicated E2E backend (npm run e2e:server) and its
// dedicated `*_e2e` database — same guard as loadTestConcurrency.js.
//
// Usage: npm run e2e:test:fulfillment-sweep
//   (after e2e:server is already running — .env.e2e sets
//   FULFILLMENT_RECONCILIATION_INTERVAL_MS=5000 so this doesn't need to
//   wait the production 2-minute interval).
require('module-alias/register');
const prisma = require('@config/prisma');

const dbUrl = process.env.DATABASE_URL || '';
if (!/\/[^/?]*_e2e(\?|$)/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a dedicated "*_e2e" database.\n` +
      `This script seeds a real order directly via Prisma — it only ever runs against the E2E database.`
  );
  process.exit(1);
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 30; // 30s — 6x the real 5s sweep interval this env uses

async function main() {
  const user = await prisma.user.findFirst({ where: { role: 'customer' } });
  const address = user
    ? await prisma.address.findFirst({ where: { userId: user.id } })
    : null;
  const product = await prisma.product.findFirst({ where: { isDeleted: false } });

  if (!user || !address || !product) {
    console.error(
      'Refusing to run: no seeded customer/address/product found. Run `npm run e2e:setup` first.'
    );
    process.exit(1);
  }

  console.log(`Seeding a 'paid but fulfillment-failed' order for user ${user.id}...`);

  const order = await prisma.order.create({
    data: {
      userId: user.id,
      total: product.price,
      addressId: address.id,
      status: 'confirmed',
      paymentStatus: 'paid',
      // stockDecremented: true so the sweep's runFulfillment does NOT
      // re-decrement real seeded stock for this synthetic order — this
      // test is only proving the sweep retries the fulfillment steps that
      // are actually safe to retry (cart-clear, notification, the
      // fulfillmentStatus/Attempts write itself), the same guard
      // runFulfillment relies on for every real retry.
      stockDecremented: true,
      oversold: false,
      fulfillmentStatus: 'failed',
      fulfillmentError: 'Synthetic failure injected by fulfillmentSweepRecovery.js',
      fulfillmentAttempts: 0,
      orderItems: {
        create: [{ productId: product.id, quantity: 1, price: product.price }],
      },
    },
  });

  console.log(`Order ${order.id} seeded at fulfillmentStatus:'failed'. Waiting for the real sweep to recover it...`);

  try {
    let finalStatus = null;
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const current = await prisma.order.findUnique({
        where: { id: order.id },
        select: { fulfillmentStatus: true, fulfillmentAttempts: true },
      });
      console.log(
        `  [t+${attempt}s] fulfillmentStatus=${current.fulfillmentStatus} fulfillmentAttempts=${current.fulfillmentAttempts}`
      );
      if (current.fulfillmentStatus === 'completed') {
        finalStatus = current;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!finalStatus) {
      console.error(
        `FAIL: order ${order.id} was not recovered to fulfillmentStatus:'completed' within ${MAX_POLLS}s. The real fulfillment-reconciliation sweep did not heal it — either the sweep isn't running, or a real regression exists.`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS: the real fulfillment-reconciliation sweep (live Redis/BullMQ + worker) recovered order ${order.id} to 'completed' after ${finalStatus.fulfillmentAttempts} attempt(s).`
    );
  } finally {
    // OrderItem has a required relation to Order (see prisma/schema.prisma) —
    // its rows must go first or the Order delete is rejected as a relation
    // violation.
    await prisma.orderItem
      .deleteMany({ where: { orderId: order.id } })
      .then(() => prisma.order.delete({ where: { id: order.id } }))
      .catch((err) => {
        console.error(`Could not clean up synthetic order ${order.id}: ${err.message}`);
      });
  }
}

main()
  .catch((err) => {
    console.error('fulfillmentSweepRecovery.js crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
