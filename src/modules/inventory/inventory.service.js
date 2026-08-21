// inventory service
const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');

/**
 * Atomically decrements stock for every item in an order.
 *
 * Each item's decrement is a single conditional update — `stock: { gte: quantity }`
 * in the WHERE clause — so the write only succeeds if enough stock is still
 * there at the exact moment it runs. If two customers race for the last unit,
 * MongoDB applies each document update atomically, so only one of them can
 * ever win that condition; the other comes back with count: 0 instead of
 * pushing stock negative.
 *
 * Pass a Prisma transaction client (`tx`) to run this as part of a larger
 * atomic operation — e.g. so an order is only confirmed if its stock was
 * actually reserved, and the whole thing rolls back together on failure.
 *
 * @param {Array<{ productId: string, quantity: number }>} orderItems
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} [client] - defaults to the top-level prisma client
 * @param {{ throwOnInsufficientStock?: boolean }} [options] - set false to decrement what's possible and report shortfalls instead of throwing (useful once payment has already been captured and the order can no longer simply be rejected)
 * @returns {Promise<Array<{ productId: string, quantity: number }>>} items that could NOT be fully decremented (empty array if everything succeeded)
 */
exports.decrementStockForOrder = async (
  orderItems,
  client = prisma,
  { throwOnInsufficientStock = true } = {}
) => {
  const insufficient = [];

  for (const item of orderItems) {
    const result = await client.product.updateMany({
      where: {
        id: item.productId,
        stock: { gte: item.quantity },
      },
      data: {
        stock: { decrement: item.quantity },
      },
    });

    if (result.count === 0) {
      insufficient.push({ productId: item.productId, quantity: item.quantity });
    }
  }

  if (insufficient.length > 0 && throwOnInsufficientStock) {
    throw new CustomError(
      'Insufficient stock for one or more items in this order',
      409,
      { insufficientItems: insufficient }
    );
  }

  return insufficient;
};

/**
 * Fetches the current stock for a single product — used by the admin
 * inventory endpoints (not the order/payment flow, which reads stock as
 * part of the atomic decrement above instead of a separate lookup).
 */
exports.getStockForProduct = async (productId) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, brand: true, stock: true },
  });

  if (!product) {
    throw new CustomError('Product not found', 404);
  }

  return product;
};

/**
 * Lists products at or below a stock threshold, lowest first, for the admin
 * "what needs restocking" view.
 *
 * PHASE 12 — "no page downloads an unnecessarily large dataset": this had
 * no upper bound at all, so a large catalog with a generous threshold
 * could return every product in one unpaginated response. Capped at a
 * generous ceiling for what's meant to be a "needs attention right now"
 * panel, not a browsable list — an admin monitoring more than this many
 * genuinely low-stock items at once needs the full paginated catalog
 * browser (GET /api/products, sorted by stock — see Inventory.jsx's "All
 * inventory" table), not this endpoint.
 */
const LOW_STOCK_LIST_CAP = 200;

exports.listLowStockProducts = async (threshold = 10) => {
  return prisma.product.findMany({
    where: {
      isDeleted: false,
      stock: { lte: threshold },
    },
    select: { id: true, name: true, brand: true, stock: true },
    orderBy: { stock: 'asc' },
    take: LOW_STOCK_LIST_CAP,
  });
};

/**
 * Manually adjusts a product's stock — restocks, corrections, write-offs.
 * This is the admin-facing counterpart to decrementStockForOrder above, and
 * deliberately reuses it for the 'decrement' action so a manual correction
 * can't drive stock negative either, even if two admins act on the same
 * product at once.
 *
 * @param {string} productId
 * @param {'set'|'increment'|'decrement'} action
 * @param {number} quantity
 * @param {number} [expectedStock] - optional optimistic-concurrency
 *   precondition for 'set': the stock value the caller last read. If the
 *   product's stock no longer matches this at write time (another admin
 *   changed it in between), the write is rejected with a 409 instead of
 *   silently overwriting their change. 'increment'/'decrement' don't need
 *   this — they're already atomic relative changes — so the parameter is
 *   ignored for those actions.
 */
exports.adjustStock = async (productId, action, quantity, expectedStock) => {
  const product = await prisma.product.findUnique({ where: { id: productId } });

  if (!product) {
    throw new CustomError('Product not found', 404);
  }

  switch (action) {
    case 'set': {
      if (expectedStock === undefined) {
        return prisma.product.update({
          where: { id: productId },
          data: { stock: quantity },
        });
      }

      // Conditional update: only applies if stock still equals what the
      // admin saw when they decided on this value. Mirrors the same
      // single-document-atomicity guarantee the decrement path below
      // relies on.
      const result = await prisma.product.updateMany({
        where: { id: productId, stock: expectedStock },
        data: { stock: quantity },
      });

      if (result.count === 0) {
        const latest = await prisma.product.findUnique({
          where: { id: productId },
          select: { stock: true },
        });

        if (!latest) {
          throw new CustomError('Product not found', 404);
        }

        throw new CustomError(
          'Stock has changed since it was loaded. Refresh and try again.',
          409,
          { currentStock: latest.stock }
        );
      }

      return prisma.product.findUnique({ where: { id: productId } });
    }

    case 'increment':
      return prisma.product.update({
        where: { id: productId },
        data: { stock: { increment: quantity } },
      });

    case 'decrement':
      // Same atomic conditional update used by the order/payment flow —
      // throws a 409 if the requested quantity isn't available.
      await exports.decrementStockForOrder(
        [{ productId, quantity }],
        prisma,
        { throwOnInsufficientStock: true }
      );
      return prisma.product.findUnique({ where: { id: productId } });

    default:
      // Unreachable once route validation is in place, but keeps this
      // function safe to call directly too.
      throw new CustomError(`Unknown stock action: ${action}`, 400);
  }
};
