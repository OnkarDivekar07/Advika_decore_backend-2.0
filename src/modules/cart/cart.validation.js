const { body } = require('express-validator');

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
    .isInt({ min: 1 })
    .withMessage('quantity must be an integer >= 1').toInt(),
];

// For PUT /cart (update quantity of item)
const validateUpdateCartItem = [
  body('productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),

  body('quantity').isInt({ min: 1 }).withMessage('quantity must be at least 1').toInt(),
];

// For DELETE /cart (remove item)
const validateRemoveCartItem = [
  body('productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),
];

module.exports = {
  validateSaveCart,
  validateUpdateCartItem,
  validateRemoveCartItem,
};
