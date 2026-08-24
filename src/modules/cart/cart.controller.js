const cartService = require('./cart.service');
const CustomError = require('@utils/customError');

// SECURITY INVARIANT (applies to every handler below): only productId,
// quantity, cartItems ([{productId, quantity}]), and couponCode are ever
// read off req.body. No handler here reads (or should ever read) a
// price/deliveryCharge/subtotal/total-shaped field from the client — every
// number in `meta.summary` comes from cartService.summarizeCart, computed
// from live Product.price + calculateDeliveryCharge (see
// src/constants/pricing.js), never from anything the request claims.
// Regression-covered in tests/integration/cart.routes.test.js's "pricing
// fields in the request body can never override the server-computed
// charge" block.

// GET /cart — the item list is `data`, as before; the "final payable
// amount" preview (subtotal/deliveryCharge/total, no client math required
// to reproduce it) rides along in `meta.summary` so it can't drift from
// how the same total is computed at draft-order time (both call
// cartService.summarizeCart / share its logic — see cart.service.js).
const getCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const cart = await cartService.getCart(userId);

    res.sendResponse({
      message: 'Cart fetched successfully',
      data: cart,
      meta: { summary: cartService.summarizeCart(cart) },
    });
  } catch (error) {
    next(error);
  }
};

// POST /cart/coupon — preview-only (see cartService.previewCoupon): checks
// a coupon code against the caller's live cart and returns what it would
// discount, without applying/persisting it. No coupon system is live yet,
// so every code currently comes back invalid — this exists so the
// endpoint, its validation, and the frontend's coupon UI are all already
// wired correctly for when one is.
const applyCoupon = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { couponCode } = req.body;

    if (!couponCode) {
      throw new CustomError('Coupon code is required.', 400);
    }

    const preview = await cartService.previewCoupon(userId, couponCode);

    res.sendResponse({
      message: 'Coupon applied successfully',
      data: preview,
    });
  } catch (error) {
    next(error);
  }
};

// POST /cart — wholesale replace (used by the frontend once, to merge a
// guest cart into the backend cart right after login). `saveUserCart`
// already returns the full post-write cart, so the summary can be derived
// from that directly — no extra round trip needed. Same `meta.summary`
// shape as GET /cart (see cartService.summarizeCart) so the frontend can
// treat every cart endpoint's summary identically instead of special-casing
// this one.
const saveCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { cartItems } = req.body;

    if (!cartItems || !Array.isArray(cartItems)) {
      throw new CustomError(
        'Invalid cart data. Must be an array of items.',
        400
      );
    }

    const cart = await cartService.saveUserCart(userId, cartItems);

    res.sendResponse({
      message: 'Cart saved successfully',
      data: cart,
      meta: { summary: cartService.summarizeCart(cart) },
    });
  } catch (error) {
    next(error);
  }
};

// PUT /cart — upsert a single item's quantity (creates the line item if
// it doesn't exist yet). Re-reads the full cart after the write so
// `meta.summary` reflects the *whole* cart post-mutation (not just the one
// line item that changed) — this is what lets the frontend treat the
// backend as the single source of truth for authenticated-cart totals
// instead of recomputing delivery charge/total itself after every tap.
const updateCartItem = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId, quantity } = req.body;

    if (!productId || quantity == null) {
      throw new CustomError('Product ID and quantity are required.', 400);
    }

    const updatedItem = await cartService.updateCartItem(
      userId,
      productId,
      quantity
    );
    const cart = await cartService.getCart(userId);

    res.sendResponse({
      message: 'Cart item updated successfully',
      data: updatedItem,
      meta: { summary: cartService.summarizeCart(cart) },
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /cart — same reasoning as PUT above: the post-removal summary
// rides along so the frontend never has to guess what removing this item
// did to the total, or issue a second request to find out.
const removeFromCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId } = req.body;

    if (!productId) {
      throw new CustomError('Product ID is required.', 400);
    }

    await cartService.removeFromCart(userId, productId);
    const cart = await cartService.getCart(userId);

    res.sendResponse({
      message: 'Item removed from cart',
      meta: { summary: cartService.summarizeCart(cart) },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCart,
  saveCart,
  updateCartItem,
  removeFromCart,
  applyCoupon,
};
