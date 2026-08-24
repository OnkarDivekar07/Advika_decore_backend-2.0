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
const { PrismaClient } = require('@prisma/client');

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
  'product',
  'user',
];

async function main() {
  for (const model of MODELS_IN_DELETE_ORDER) {
    const { count } = await prisma[model].deleteMany({});
    console.log(`  cleared ${model}: ${count} row(s)`);
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
  });
