// wishlist.service.js
//
// Single source of truth for wishlist persistence. Only signed-in users
// ever reach this module (all wishlist routes sit behind `authenticate` —
// see wishlist.routes.js). Unlike Cart, there's no guest-mode/localStorage
// mirror on the frontend — wishlisting requires an account, the same way
// addresses and orders do.
const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');
const logger = require('@config/logger');

// A wishlisted product can be deleted/soft-deleted after being saved —
// same situation cart.service.js's getCart handles for cart rows. Those
// rows are filtered out of the response and opportunistically swept from
// the DB (best-effort; never allowed to fail the read), rather than
// surfaced as a half-populated item the frontend has to guard against.
const getWishlist = async (userId) => {
  const rows = await prisma.wishlist.findMany({
    where: { userId },
    include: { product: true },
    orderBy: { createdAt: 'desc' },
  });

  const valid = [];
  const orphanedIds = [];
  for (const row of rows) {
    if (row.product && !row.product.isDeleted) {
      valid.push(row);
    } else {
      orphanedIds.push(row.id);
    }
  }

  if (orphanedIds.length > 0) {
    Promise.resolve(prisma.wishlist.deleteMany({ where: { id: { in: orphanedIds } } })).catch(
      (err) => logger.warn('Failed to sweep orphaned wishlist rows', { err: err.message })
    );
  }

  return valid;
};

// POST /wishlist — upsert so re-adding an already-wishlisted product is a
// harmless no-op (returns the existing row) instead of a unique-constraint
// error the frontend would have to special-case.
const addToWishlist = async (userId, productId) => {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.isDeleted) {
    throw new CustomError('Product not found', 404);
  }

  return prisma.wishlist.upsert({
    where: { userId_productId: { userId, productId } },
    update: {},
    create: { userId, productId },
    include: { product: true },
  });
};

// DELETE /wishlist/:productId
const removeFromWishlist = async (userId, productId) => {
  const existing = await prisma.wishlist.findUnique({
    where: { userId_productId: { userId, productId } },
  });

  if (!existing) {
    throw new CustomError('Item not found in wishlist', 404);
  }

  await prisma.wishlist.delete({ where: { id: existing.id } });
};

module.exports = {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
};
