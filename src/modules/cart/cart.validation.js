const { body } = require('express-validator');

// Upper bound on a single line item's quantity. This isn't a real business
// limit (the stock check in cart.service is what actually decides what's
// purchasable) — it's a cheap input-sanity guard so an obviously bogus or
// abusive value (e.g. a client bug looping an increment, or someone probing
// with 9999999999999) gets a clean 422 here instead of round-tripping to the
// DB to be rejected as "insufficient stock" anyway.
const MAX_CART_QUANTITY = 10000;

// For POST /cart (saveCart)
const validateSaveCart = [
  body('cartItems')
    .isArray({ min: 1 })
    .withMessage('cartItems must be a non-empty array'),

  body('cartItems.*.productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),

  body('cartItems.*.quantity')
    .isInt({ min: 1, max: MAX_CART_QUANTITY })
    .withMessage(
      `quantity must be an integer between 1 and ${MAX_CART_QUANTITY}`
    )
    .toInt(),
];

// For PUT /cart (update quantity of item)
const validateUpdateCartItem = [
  body('productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),

  body('quantity')
    .isInt({ min: 1, max: MAX_CART_QUANTITY })
    .withMessage(
      `quantity must be an integer between 1 and ${MAX_CART_QUANTITY}`
    )
    .toInt(),
];

// For DELETE /cart (remove item)
const validateRemoveCartItem = [
  body('productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),
];

// For POST /cart/coupon (preview a coupon against the current cart)
const validateApplyCoupon = [
  body('couponCode')
    .isString()
    .withMessage('couponCode must be a string')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('couponCode is required')
    .isLength({ max: 64 })
    .withMessage('couponCode is too long'),
];

module.exports = {
  validateSaveCart,
  validateUpdateCartItem,
  validateRemoveCartItem,
  validateApplyCoupon,
  MAX_CART_QUANTITY,
};
