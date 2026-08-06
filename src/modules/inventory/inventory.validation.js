const { body, param, query } = require('express-validator');
const mongoose = require('mongoose');

exports.validateProductIdParam = [
  param('productId')
    .trim()
    .notEmpty()
    .withMessage('Product ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
];

exports.validateAdjustStock = [
  param('productId')
    .trim()
    .notEmpty()
    .withMessage('Product ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),

  body('action')
    .notEmpty()
    .withMessage('Action is required')
    .isIn(['set', 'increment', 'decrement'])
    .withMessage("Action must be one of 'set', 'increment', or 'decrement'"),

  body('quantity')
    .notEmpty()
    .withMessage('Quantity is required')
    .isInt({ min: 0 })
    .withMessage('Quantity must be a non-negative integer')
    .toInt(),
];

exports.validateLowStockQuery = [
  query('threshold')
    .optional()
    .isInt({ min: 0 })
    .withMessage('threshold must be a non-negative integer')
    .toInt(),
];
