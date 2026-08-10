// src/constants/pricing.js
//
// Flat-rate delivery charge: free above a threshold, a fixed fee below it.
// This is the ONE place that rule lives on the backend — order.service.js
// (which computes the amount actually charged via Razorpay/COD — see
// payment.controller.js's `draftOrder.total * 100` and
// shipping.service.js's `order.total`) imports calculateDeliveryCharge
// from here rather than re-deriving it, so the charge and the cart-page
// preview can't drift apart from a copy-pasted threshold going stale in
// one place.
//
// The frontend mirrors these two numbers in src/config/pricing.js purely
// to render the cart preview without an extra round trip — that's safe
// because this is a static, publicly-known rule (not inventory/user data
// that can go stale), but it means the two files must be updated
// together. If this rule ever needs to vary per-order (promotions,
// per-pincode shipping, etc.), that mirroring assumption breaks and the
// frontend should start asking the backend for the number instead.
const CustomError = require('@utils/customError');

const FREE_DELIVERY_THRESHOLD = 600;
const DELIVERY_CHARGE = 49;

/**
 * @param {number} subtotal - sum of (price * quantity) across order/cart items
 * @returns {number} delivery charge to apply — 0 once subtotal clears the threshold
 */
const calculateDeliveryCharge = (subtotal) =>
  subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_CHARGE;

// --- Discount / coupon placeholder architecture -----------------------------
// There is no Coupon model or admin-managed coupon list yet — this is the
// single seam a real implementation will plug into later, so the rest of the
// codebase (order.service.js's total calc, the cart-coupon endpoint, the
// frontend's coupon input) can be wired up against it *now* without knowing
// or caring whether redemption is real yet.
//
// Today: no code is quietly accepted. `couponCode == null` (the normal,
// no-coupon path — every existing cart/order) always resolves to a silent
// 0, exactly like before this existed. Passing an actual code always throws
// — there's nothing valid to redeem it against — rather than pretending it
// worked or forging a discount amount, so a client trying to sneak a
// discount in by just supplying a truthy string gets rejected the same as a
// typo'd one. When real coupons exist, this function becomes a DB lookup
// (code -> % off / flat off / min-subtotal rules, expiry, per-user limits,
// etc.) and everything downstream needs no changes: it already only trusts
// this return value, never anything the client claims the discount is.
//
// @param {number} subtotal - sum of (price * quantity) across cart/order items
// @param {string|null|undefined} couponCode - code the user is attempting to apply, if any
// @returns {number} discount amount in the same currency unit as subtotal
// @throws {CustomError} 404 if a non-empty couponCode doesn't resolve to a live coupon
const calculateDiscount = (subtotal, couponCode) => {
  if (!couponCode) return 0;
  throw new CustomError('Invalid or expired coupon code', 404, { couponCode });
};

module.exports = {
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_CHARGE,
  calculateDeliveryCharge,
  calculateDiscount,
};
