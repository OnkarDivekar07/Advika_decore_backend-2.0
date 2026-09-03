// cart.service.js
//
// Single source of truth for cart persistence. Only signed-in users ever
// reach this module (all cart routes sit behind `authenticate` — see
// cart.routes.js); the guest cart itself lives entirely in the frontend's
// localStorage and is merged in here, once, via saveUserCart() right after
// login. See CartContext.jsx on the frontend for that flow.
const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');
const logger = require('@config/logger');
const withTransactionRetry = require('@utils/withTransactionRetry');
const {
  calculateDeliveryCharge,
  calculateDiscount,
} = require('@constants/pricing');

// Every mutation needs the same guarantee: the product being added still
// exists, isn't soft-deleted, and has enough stock for the requested
// quantity. Centralizing it here means updateCartItem and saveUserCart
// can't drift on what "valid" means, and the error shapes line up with
// what the frontend's isCartConflictError() already knows how to handle:
// 404 for a gone/removed product, 409 (with a "stock"-flavored message,
// matching inventory.service's stock-conflict convention) for not enough
// left.
const assertProductAvailable = async (productId, quantity) => {
  const product = await prisma.product.findUnique({ where: { id: productId } });

  if (!product || product.isDeleted) {
    throw new CustomError('Product not found', 404);
  }
  if (product.stock < quantity) {
    // Structured `errors` payload (in addition to the human-readable
    // message) so the frontend can react precisely — e.g. clamp the
    // stepper straight to what's actually available — instead of having
    // to string-parse "Only N left." out of the message.
    throw new CustomError(
      `Insufficient stock for "${product.name}". Only ${product.stock} left.`,
      409,
      { productId, availableStock: product.stock }
    );
  }
  return product;
};

// GET /cart — a soft-deleted (or hard-deleted) product can still have a
// leftover cart row (it was added before being delisted/removed), so
// those are filtered out of the response rather than surfaced to the
// client as a half-populated item. They're also opportunistically swept
// from the DB here: GET is the one endpoint guaranteed to run every time
// a cart is opened, so without this the row lingers forever (the client
// never learns its id since it's filtered out, so it can never call
// DELETE for it either). The cleanup is best-effort and never allowed to
// fail the read — a user's cart should still load even if the sweep
// itself has a problem.
const getCart = async (userId) => {
  const rows = await prisma.cart.findMany({
    where: { userId },
    include: { product: true },
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
    // Wrapped in Promise.resolve() so this is safe even against a test
    // double (or any future implementation) that doesn't itself return a
    // promise — the sweep must never be able to throw synchronously and
    // take the read down with it.
    Promise.resolve(
      prisma.cart.deleteMany({ where: { id: { in: orphanedIds } } })
    ).catch((err) =>
      logger.warn('Failed to sweep orphaned cart rows', { err: err.message })
    );
  }

  return valid;
};

// Shared by GET /cart (as a preview, so the cart page never has to
// re-derive/mirror this math itself) and by order.service.js's draft-order
// total — same shape, same rule, one place. No discount here: a discount
// only exists once a coupon has actually been validated (see
// previewCoupon/calculateDiscount below), and a bare cart has no coupon
// attached to it yet, so baking a phantom 0 "discount" line into the
// summary just to mirror the order shape would be misleading rather than
// the actual "final payable amount" of the cart in its current state.
const summarizeCart = (rows) => {
  const subtotal = rows.reduce(
    (sum, row) => sum + row.product.price * row.quantity,
    0
  );
  const deliveryCharge = calculateDeliveryCharge(subtotal);
  return { subtotal, deliveryCharge, total: subtotal + deliveryCharge };
};

// POST /cart/coupon — validates a coupon against the caller's *current*
// cart and previews the discount it would apply, without persisting
// anything (there's no cart-level entity to persist a coupon selection
// onto pre-checkout — that happens for real at draft-order creation, see
// order.service.js's createDraftOrderService, which re-validates the same
// code against the cart it actually charges). Re-reads the cart rather
// than trusting a client-supplied subtotal, for the same reason nothing
// else in this module trusts client-supplied prices/totals.
const previewCoupon = async (userId, couponCode) => {
  const rows = await getCart(userId);
  if (rows.length === 0) {
    throw new CustomError('Your cart is empty', 400);
  }
  const { subtotal, deliveryCharge } = summarizeCart(rows);
  const discount = calculateDiscount(subtotal, couponCode); // throws if invalid/expired
  return {
    couponCode,
    subtotal,
    deliveryCharge,
    discount,
    total: Math.max(0, subtotal + deliveryCharge - discount),
  };
};

// POST /cart — wholesale replace, used exactly once per session by the
// frontend right after login to fold a guest cart into the backend cart
// (see CartContext.syncGuestCartToBackend). Every item is validated
// up front so one bad/out-of-stock item can't silently take the rest of
// the cart down with it, and the swap itself is one transaction so a
// mid-way failure can't leave the user with an emptied cart.
const saveUserCart = async (userId, cartItems) => {
  // De-dupe by productId (last quantity wins). The frontend's merge logic
  // already guarantees unique productIds, but the service shouldn't rely
  // on every future caller upholding that.
  const dedupedByProduct = new Map();
  for (const item of cartItems) {
    dedupedByProduct.set(item.productId, item.quantity);
  }
  const items = Array.from(dedupedByProduct, ([productId, quantity]) => ({
    productId,
    quantity,
  }));

  await Promise.all(
    items.map((item) => assertProductAvailable(item.productId, item.quantity))
  );

  // Interactive transaction (matches the pattern order.service.js already
  // uses elsewhere) so the delete+recreate is atomic — a mid-way failure
  // can't leave the user with an emptied cart.
  const rows = await withTransactionRetry(async (tx) => {
    await tx.cart.deleteMany({ where: { userId } });
    await tx.cart.createMany({
      data: items.map((item) => ({
        userId,
        productId: item.productId,
        quantity: item.quantity,
      })),
    });
    return tx.cart.findMany({ where: { userId }, include: { product: true } });
  });

  return rows.filter((row) => row.product && !row.product.isDeleted);
};

// PUT /cart — upsert a single line item. This is the one primitive that
// backs both "add to cart" and the quantity stepper on the frontend: the
// client computes the target quantity (existing + delta, or just the new
// quantity) and calls this with the total. It MUST create the row when it
// doesn't exist yet — using a plain updateMany here (as before) silently
// no-ops for a brand-new item, which made "add to cart" a no-op for any
// signed-in user adding a product they didn't already have.
const updateCartItem = async (userId, productId, quantity) => {
  await assertProductAvailable(productId, quantity);

  return prisma.cart.upsert({
    where: { userId_productId: { userId, productId } },
    update: { quantity },
    create: { userId, productId, quantity },
    include: { product: true },
  });
};

// DELETE /cart — removing an item that isn't there anymore (already
// removed in another tab/device) isn't a silent success: the frontend
// treats a 404 here as a stale-cart signal and resyncs from the server
// instead of trusting its own optimistic removal.
const removeFromCart = async (userId, productId) => {
  const result = await prisma.cart.deleteMany({ where: { userId, productId } });
  if (result.count === 0) {
    throw new CustomError('Item not found in cart', 404);
  }
};

module.exports = {
  getCart,
  summarizeCart,
  previewCoupon,
  saveUserCart,
  updateCartItem,
  removeFromCart,
};
