const express = require('express');
const router = express.Router();

const {
  saveCart,
  getCart,
  updateCartItem,
  removeFromCart,
} = require('./cart.controller');

const authenticate = require('@middlewares/authenticate');
const {
  validateSaveCart,
  validateUpdateCartItem,
  validateRemoveCartItem,
} = require('./cart.validation');
const validateRequest = require('@middlewares/validateRequest');

// Protect all cart routes
router.use(authenticate);

router.post('/', validateSaveCart, validateRequest, saveCart);

router.get('/', getCart);

router.put('/', validateUpdateCartItem, validateRequest, updateCartItem);

router.delete('/', validateRemoveCartItem, validateRequest, removeFromCart);

module.exports = router;
