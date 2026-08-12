const { body, param } = require('express-validator');
const mongoose = require('mongoose');
const { INDIAN_PINCODE_REGEX } = require('@constants/pincode');

exports.validateServiceabilityCheck = [
  body('pincode')
    .trim()
    .notEmpty()
    .withMessage('Pincode is required')
    // Shared with user.validation.js's address pincode field — see
    // src/constants/pincode.js. Was isPostalCode('IN'), which only checks
    // digit-count shape and would pass a leading-zero value ('012345')
    // that isn't a real Indian PIN code; this route now rejects that
    // exactly like the address form already does, rather than sending it
    // on to Ekart to answer for us.
    .matches(INDIAN_PINCODE_REGEX)
    .withMessage('Enter a valid 6-digit Indian pincode'),

  body('paymentMode')
    .optional()
    .isIn(['COD', 'PREPAID'])
    .withMessage("paymentMode must be 'COD' or 'PREPAID'"),

  body('weightKg')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('weightKg must be a non-negative number')
    .toFloat(),

  // Optional — when the caller (e.g. the cart/checkout page) already knows
  // the cart subtotal, passing it here lets the response also include the
  // delivery-charge / free-delivery fields for that amount (see
  // shipping.service.js's checkServiceability), so a single call can
  // answer serviceability + pricing together instead of two round trips.
  // Omitted entirely, the response shape is unchanged from before this
  // existed — see the "stable normalized contract" note there.
  body('subtotal')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('subtotal must be a non-negative number')
    .toFloat(),
];

exports.validateOrderIdParam = [
  param('orderId')
    .trim()
    .notEmpty()
    .withMessage('Order ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
];

exports.validateCancelShipment = [
  ...exports.validateOrderIdParam,
  body('reason')
    .optional()
    .isString()
    .withMessage('reason must be a string'),
];
