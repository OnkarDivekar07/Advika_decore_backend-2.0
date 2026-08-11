const { body, param } = require('express-validator');

const mongoose = require('mongoose');

// Upper bound on a Buy Now line item's quantity — same cheap input-sanity
// guard cart.validation.js uses for cart quantities (MAX_CART_QUANTITY).
// The real limit is always the live stock check in order.service.js.
const MAX_BUY_NOW_QUANTITY = 10000;

const validateDraftOrder = [
  body('selectedAddressId')
    .trim()
    .notEmpty()
    .withMessage('Address ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),

  // Optional — see calculateDiscount in src/constants/pricing.js. Only
  // shape-validated here; whether the code actually resolves to anything
  // is a service-layer concern (no coupons exist yet, so any code fails
  // there with a 404), not a request-validation one.
  body('couponCode')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('couponCode must be a string')
    .bail()
    .trim()
    .isLength({ max: 64 })
    .withMessage('couponCode is too long'),

  // Optional "Buy Now" line item — when present, the draft order is built
  // from this single product instead of the user's cart (see
  // order.service.js). Only shape/type-validated here; whether the
  // product exists, is still active, and has enough stock is re-checked
  // server-side at draft-order time exactly like every cart item is, so
  // Buy Now can never skip that re-validation the way the old
  // frontend-only Buy Now flow did.
  body('buyNow')
    .optional({ nullable: true })
    .isObject()
    .withMessage('buyNow must be an object'),

  body('buyNow.productId')
    .if(body('buyNow').exists())
    .trim()
    .notEmpty()
    .withMessage('buyNow.productId is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format for buyNow.productId'),

  body('buyNow.quantity')
    .if(body('buyNow').exists())
    .isInt({ min: 1, max: MAX_BUY_NOW_QUANTITY })
    .withMessage(`buyNow.quantity must be an integer between 1 and ${MAX_BUY_NOW_QUANTITY}`)
    .toInt(),
];

const validateOrderIdParam = [
  param('id')
    .trim()
    .notEmpty()
    .withMessage('Order ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
];

module.exports = {
  validateDraftOrder,
  validateOrderIdParam,
  MAX_BUY_NOW_QUANTITY,
};
