// tests/e2e-helpers/prepareLoadTestCatalog.js
//
// Pattern 23 (realistic load/concurrency test) — the k6 realistic-mix
// scenario (tests/load/k6-realistic-mix.js) discovers every product id it
// uses at runtime via the real GET /api/products API (never a hardcoded
// id, unlike the legacy tests/load-test.js), but it needs *something* in
// the catalog to discover. This idempotent prep step guarantees two
// distinctly-named, distinctly-purposed pools exist before a run:
//
//   - LoadTestCatalog-*: a normal-stock browsing/detail pool, for the
//     catalog/search and product-detail traffic buckets (read-only, never
//     depleted).
//   - LoadTestTxnPool-*: a small, deliberately HIGH-stock pool reserved for
//     the transactional-checkout bucket only. Real COD orders decrement
//     real stock — if that bucket drew from the same normal-stock catalog
//     pool, a longer run could legitimately exhaust it, and the resulting
//     409s would look like a capacity problem when they're actually just
//     expected stock depletion, muddying the very p95/error-rate numbers
//     this pattern is trying to measure cleanly.
//
// Idempotent and additive-only: reruns top up each pool to its target
// count/stock rather than deleting and recreating, so re-running this
// between load-test profiles (baseline, peak, stress, ...) never
// invalidates ids a previous profile's k6 setup() already discovered.
//
// Same "only ever the dedicated *_e2e database" guard as
// loadTestConcurrency.js / loadTestPeakHour.js / prisma/reset-e2e.js.
require('module-alias/register');
const prisma = require('@config/prisma');

const dbUrl = process.env.DATABASE_URL || '';
if (!/\/[^/?]*_e2e(\?|$)/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a dedicated "*_e2e" database.\n` +
      `This script creates real products against whatever DATABASE_URL points at — it only ever runs against the E2E database.`
  );
  process.exit(1);
}

const CATALOG_PREFIX = 'LoadTestCatalog';
const TXN_POOL_PREFIX = 'LoadTestTxnPool';
const CATALOG_TARGET_COUNT = Number(process.env.LOAD_TEST_CATALOG_SIZE) || 24;
const CATALOG_STOCK = 200;
const TXN_POOL_TARGET_COUNT = Number(process.env.LOAD_TEST_TXN_POOL_SIZE) || 10;
const TXN_POOL_TOP_UP_STOCK = 5000;

const CATEGORIES = ['Rubber & Matting', 'Lighting', 'Electrical', 'Seat Covers', 'Mirrors'];

async function ensurePool({ prefix, targetCount, stock, categoryCycle = false }) {
  const existing = await prisma.product.count({
    where: { name: { startsWith: prefix }, isDeleted: false },
  });
  const toCreate = Math.max(0, targetCount - existing);

  if (toCreate === 0) {
    // Top up stock on the existing pool rather than leaving it to decay
    // across repeated transactional-bucket runs — the whole point of the
    // txn pool is that it should never realistically run dry mid-run.
    await prisma.product.updateMany({
      where: { name: { startsWith: prefix }, isDeleted: false, stock: { lt: stock } },
      data: { stock },
    });
    console.log(`  ${prefix}: ${existing} already exist (target ${targetCount}) — topped up stock to ${stock} where needed.`);
    return;
  }

  console.log(`  ${prefix}: ${existing} exist, creating ${toCreate} more (target ${targetCount})...`);
  for (let i = 0; i < toCreate; i += 1) {
    const index = existing + i;
    // eslint-disable-next-line no-await-in-loop
    await prisma.product.create({
      data: {
        name: `${prefix}-${index}`,
        category: categoryCycle ? [CATEGORIES[index % CATEGORIES.length]] : [CATEGORIES[0]],
        brand: 'Advika',
        price: 299 + (index % 20) * 25,
        stock,
        images: [],
        description: `Synthetic product created by prepareLoadTestCatalog.js for Pattern 23's k6 realistic-mix load test — safe to delete (see cleanupLoadTestCatalog.js).`,
      },
    });
  }
}

async function main() {
  console.log('Preparing load-test catalog pools in the E2E database...');
  await ensurePool({ prefix: CATALOG_PREFIX, targetCount: CATALOG_TARGET_COUNT, stock: CATALOG_STOCK, categoryCycle: true });
  await ensurePool({ prefix: TXN_POOL_PREFIX, targetCount: TXN_POOL_TARGET_COUNT, stock: TXN_POOL_TOP_UP_STOCK });
  console.log('Done. k6-realistic-mix.js will discover these by name prefix via GET /api/products?search=... at runtime.');
}

main()
  .catch((err) => {
    console.error('prepareLoadTestCatalog crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
