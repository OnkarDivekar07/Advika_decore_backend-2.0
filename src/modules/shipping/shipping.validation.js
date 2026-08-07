const { body, param } = require('express-validator');
const mongoose = require('mongoose');

exports.validateServiceabilityCheck = [
  body('pincode')
    .trim()
    .notEmpty()
    .withMessage('Pincode is required')
    .isPostalCode('IN')
    .withMessage('Invalid Indian pincode'),

  body('paymentMode')
    .optional()
    .isIn(['COD', 'PREPAID'])
    .withMessage("paymentMode must be 'COD' or 'PREPAID'"),

  body('weightKg')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('weightKg must be a non-negative number')
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
