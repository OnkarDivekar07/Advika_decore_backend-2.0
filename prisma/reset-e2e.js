// prisma/reset-e2e.js
//
// Wipes every collection in the dedicated E2E database, then reseeds it
// (via the existing prisma/seed.js — same admin + Advika Auto catalog dev
// already relies on, so E2E tests exercise the same realistic data shape).
// Run before an E2E suite via `npm run e2e:reset-db` (loads .env.e2e).
//
// Guarded to refuse to run against anything whose DATABASE_URL doesn't
// look like the dedicated E2E database — this script deletes ALL rows in
// whatever database DATABASE_URL points at, so accidentally running it
// against dev/production data must be structurally impossible, not just
// discouraged by convention.
// Needed here (unlike prisma/seed.js, which has no @-aliased requires of
// its own) because invalidateCacheByPrefix below is the app's real
// src/utils module, and it internally does require('@config/redis') —
// module-alias/register is what makes that resolve outside server.js's
// own require chain, the same one call server.js itself makes.
require('module-alias/register');
const { PrismaClient } = require('@prisma/client');
const redis = require('@config/redis');
const invalidateCacheByPrefix = require('@utils/invalidateCacheByPrefix');

const dbUrl = process.env.DATABASE_URL || '';
if (!/\/[^/?]*_e2e(\?|$)/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a dedicated "*_e2e" database.\n` +
      `Got: ${dbUrl.replace(/\/\/.*@/, '//<redacted>@')}\n` +
      `This script is destructive (deletes every row) and only ever runs against the E2E database.`
  );
  process.exit(1);
}

const prisma = new PrismaClient();

// Order matters: children before the parents they reference (Prisma on
// Mongo has no cascading deletes at the DB level).
const MODELS_IN_DELETE_ORDER = [
  'webhookEvent',
  'shipment',
  'orderItem',
  'order',
  'cart',
  'wishlist',
  'review',
  'contactQuery',
  'address',
  'banner',
  'siteContent',
  'product',
  'user',
];

// Every cachePrefix the app itself invalidates on a real write (see
// product.service.js / homepage.service.js's own invalidateCacheByPrefix
// calls) — kept in sync with those call sites, not derived automatically.
// This script bypasses the app's normal write paths entirely (raw
// deleteMany + a direct reseed, not a real create/update/delete request),
// so none of that app-side cache invalidation ever fires here. Without
// this, a product-search result cached by an earlier run (e.g. an empty
// result cached while a product was mid-test soft-deleted) can outlive
// this reset — confirmed live: re-running the E2E suite without this found
// a stale empty GET /api/products?search=... result still being served
// from Redis for a product this script had just recreated fresh.
const CACHE_PREFIXES_TO_CLEAR = ['allProducts', 'newArrivalProducts', 'banners'];

async function main() {
  for (const model of MODELS_IN_DELETE_ORDER) {
    const { count } = await prisma[model].deleteMany({});
    console.log(`  cleared ${model}: ${count} row(s)`);
  }
  for (const prefix of CACHE_PREFIXES_TO_CLEAR) {
    // eslint-disable-next-line no-await-in-loop
    await invalidateCacheByPrefix(prefix);
    console.log(`  cleared Redis cache prefix: ${prefix}`);
  }
  console.log('E2E database wiped.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });
