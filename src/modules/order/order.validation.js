const { body, param } = require('express-validator');

const mongoose = require('mongoose');

const validateDraftOrder = [
  body('selectedAddressId')
    .trim()
    .notEmpty()
    .withMessage('Address ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
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
