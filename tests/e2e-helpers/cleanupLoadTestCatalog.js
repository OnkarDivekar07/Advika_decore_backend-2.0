// tests/e2e-helpers/cleanupLoadTestCatalog.js
//
// Removes everything prepareLoadTestCatalog.js and a k6-realistic-mix.js
// run leave behind in the E2E database: the LoadTestCatalog-*/
// LoadTestTxnPool-* products, and the throwaway buyer users/orders/carts
// the transactional-checkout bucket and per-VU session buyers created
// (identified by the same 'Realistic Load Test' name markers the k6
// script's setup/address calls use). Run this after a load-test session is
// done — not required between individual profiles (A/B/C/D/E can share one
// prepared catalog), since prepareLoadTestCatalog.js is idempotent either
// way.
//
// Same "only ever the dedicated *_e2e database" guard as its siblings.
require('module-alias/register');
const prisma = require('@config/prisma');

const dbUrl = process.env.DATABASE_URL || '';
if (!/\/[^/?]*_e2e(\?|$)/.test(dbUrl)) {
  console.error(
    `Refusing to run: DATABASE_URL does not look like a dedicated "*_e2e" database.\n` +
      `This script deletes real data against whatever DATABASE_URL points at — it only ever runs against the E2E database.`
  );
  process.exit(1);
}

const PRODUCT_PREFIXES = ['LoadTestCatalog', 'LoadTestTxnPool'];
const BUYER_NAME_MARKER = 'Realistic Load Test Buyer';

async function main() {
  console.log('Cleaning up k6 realistic-mix load-test data from the E2E database...');

  for (const prefix of PRODUCT_PREFIXES) {
    const products = await prisma.product.findMany({
      where: { name: { startsWith: prefix } },
      select: { id: true },
    });
    const productIds = products.map((p) => p.id);
    if (productIds.length === 0) {
      console.log(`  ${prefix}: none found.`);
      continue;
    }

    // Soft-delete (isDeleted:true, same convention as product.service.js's
    // real deleteProduct), not a hard delete: a LoadTestTxnPool product
    // that actually had real COD orders placed against it during the
    // transactional-checkout bucket is referenced by real OrderItem rows,
    // and Prisma's own required-relation constraint correctly refuses a
    // hard delete in that case (confirmed live — P2014). Soft-deleting
    // removes it from every real catalog/search/detail endpoint (all of
    // which already filter isDeleted:false) without touching order
    // history, exactly like removing a real discontinued product would.
    const { count } = await prisma.product.updateMany({
      where: { id: { in: productIds } },
      data: { isDeleted: true },
    });
    console.log(`  ${prefix}: soft-deleted ${count} product(s).`);
  }

  // Two-step query, not a nested relation filter (User -> addresses ->
  // some) — Prisma's MongoDB connector doesn't reliably support that
  // (confirmed empirically here: it matched zero rows even though matching
  // addresses existed; same limitation loadTestConcurrency.js's own
  // comment documents for a different relation on Order/OrderItem).
  const markedAddresses = await prisma.address.findMany({
    where: { name: BUYER_NAME_MARKER },
    select: { userId: true },
  });
  const buyerIds = [...new Set(markedAddresses.map((a) => a.userId))];
  if (buyerIds.length > 0) {
    // Orders are left in place deliberately — deleting Order rows without
    // also reconciling any stock they decremented would be its own data
    // -integrity hazard, and they carry the run's own audit trail (useful
    // to inspect after a load-test session, same reasoning
    // loadTestConcurrency.js's own comments give for not deleting orders).
    // Both Order.userId -> User and Order.addressId -> Address are
    // required relations with no cascade, so a buyer who placed any real
    // order can't have their user OR address rows touched without
    // deleting the order first (confirmed live — same P2014 the product
    // cleanup above hit, on both relations) — only buyers with zero
    // orders (pure browsing/cart-only VUs that never reached
    // draft/checkout) are actually cleaned up; buyers with real orders are
    // left completely untouched, address included, alongside their order.
    const ordersByBuyer = await prisma.order.findMany({
      where: { userId: { in: buyerIds } },
      select: { userId: true },
    });
    const buyersWithOrders = new Set(ordersByBuyer.map((o) => o.userId));
    const deletableBuyerIds = buyerIds.filter((id) => !buyersWithOrders.has(id));

    if (deletableBuyerIds.length > 0) {
      await prisma.cart.deleteMany({ where: { userId: { in: deletableBuyerIds } } });
      await prisma.address.deleteMany({ where: { userId: { in: deletableBuyerIds } } });
      await prisma.user.deleteMany({ where: { id: { in: deletableBuyerIds } } });
    }
    console.log(
      `  ${buyerIds.length} synthetic buyer(s) found: deleted ${deletableBuyerIds.length} account(s) ` +
        `(cart/address/user) with no orders, left ${buyersWithOrders.size} account(s) with real orders ` +
        `completely untouched for inspection.`
    );
  } else {
    console.log('  No synthetic load-test buyers found.');
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('cleanupLoadTestCatalog crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
