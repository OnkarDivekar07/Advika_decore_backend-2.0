const { body, param } = require('express-validator');

// For POST /api/wishlist (add)
const validateAddToWishlist = [
  body('productId')
    .isString()
    .withMessage('productId must be a string')
    .notEmpty()
    .withMessage('productId is required'),
];

// For DELETE /api/wishlist/:productId (remove)
const validateWishlistProductParam = [
  param('productId').notEmpty().withMessage('productId is required'),
];

module.exports = {
  validateAddToWishlist,
  validateWishlistProductParam,
};
