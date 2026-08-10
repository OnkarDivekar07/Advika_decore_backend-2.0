const { body, param } = require('express-validator');

const mongoose = require('mongoose');

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
};
