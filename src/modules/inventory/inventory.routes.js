// inventory routes
const express = require('express');
const router = express.Router();

const {
  getStock,
  getLowStockProducts,
  adjustStock,
} = require('./inventory.controller');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const validateRequest = require('@middlewares/validateRequest');
const {
  validateProductIdParam,
  validateAdjustStock,
  validateLowStockQuery,
} = require('./inventory.validation');

// Inventory management exposes exact stock counts and lets you mutate them
// directly — admin-only, no public routes in this module.
router.use(authenticate, authorizeAdminOnly);

/**
 * @route   GET /api/inventory/low-stock
 * @desc    List products at or below a stock threshold (default 10)
 * @access  Admin
 */
router.get(
  '/low-stock',
  validateLowStockQuery,
  validateRequest,
  getLowStockProducts
);

/**
 * @route   GET /api/inventory/:productId
 * @desc    Get current stock for a single product
 * @access  Admin
 */
router.get(
  '/:productId',
  validateProductIdParam,
  validateRequest,
  getStock
);

/**
 * @route   PATCH /api/inventory/:productId
 * @desc    Manually adjust stock (set / increment / decrement) — restocks and corrections
 * @access  Admin
 */
router.patch(
  '/:productId',
  validateAdjustStock,
  validateRequest,
  adjustStock
);

module.exports = router;
