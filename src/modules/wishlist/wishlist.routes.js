const express = require('express');
const router = express.Router();

const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
} = require('./wishlist.controller');

const authenticate = require('@middlewares/authenticate');
const {
  validateAddToWishlist,
  validateWishlistProductParam,
} = require('./wishlist.validation');
const validateRequest = require('@middlewares/validateRequest');

// Protect all wishlist routes — no guest/anonymous wishlist exists (see
// wishlist.service.js).
router.use(authenticate);

/**
 * @route   GET /api/wishlist
 * @desc    Get the logged-in user's wishlist
 * @access  User
 */
router.get('/', getWishlist);

/**
 * @route   POST /api/wishlist
 * @desc    Add a product to the logged-in user's wishlist
 * @access  User
 */
router.post('/', validateAddToWishlist, validateRequest, addToWishlist);

/**
 * @route   DELETE /api/wishlist/:productId
 * @desc    Remove a product from the logged-in user's wishlist
 * @access  User
 */
router.delete(
  '/:productId',
  validateWishlistProductParam,
  validateRequest,
  removeFromWishlist
);

module.exports = router;
