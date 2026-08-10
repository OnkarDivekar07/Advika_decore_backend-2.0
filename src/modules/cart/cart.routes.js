const express = require('express');
const router = express.Router();

const {
  saveCart,
  getCart,
  updateCartItem,
  removeFromCart,
  applyCoupon,
} = require('./cart.controller');

const authenticate = require('@middlewares/authenticate');
const {
  validateSaveCart,
  validateUpdateCartItem,
  validateRemoveCartItem,
  validateApplyCoupon,
} = require('./cart.validation');
const validateRequest = require('@middlewares/validateRequest');

// Protect all cart routes
router.use(authenticate);

router.post('/', validateSaveCart, validateRequest, saveCart);

router.get('/', getCart);

router.put('/', validateUpdateCartItem, validateRequest, updateCartItem);

router.delete('/', validateRemoveCartItem, validateRequest, removeFromCart);

// Preview-only — see cart.service.js's previewCoupon. Placed after the
// item CRUD routes but still under the same `authenticate` gate as
// everything else in this router.
router.post('/coupon', validateApplyCoupon, validateRequest, applyCoupon);

module.exports = router;
