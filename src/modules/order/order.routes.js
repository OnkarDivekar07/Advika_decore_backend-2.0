const express = require('express');
const router = express.Router();

const {
  createDraftOrder,
  getUserOrders,
  getOrders,
  getOrderById,
} = require('./order.controller');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const validateRequest = require('@middlewares/validateRequest');
const { validateDraftOrder, validateOrderIdParam } = require('./order.validation'); // renamed from admin.validation to avoid confusion

// -----------------------------------------------------------------------------
// @route   POST /api/orders
// @desc    Create a draft order
// @access  Authenticated User
// -----------------------------------------------------------------------------
router.post(
  '/',
  authenticate,
  validateDraftOrder,
  validateRequest,
  createDraftOrder
);

// -----------------------------------------------------------------------------
// @route   GET /api/orders
// @desc    Get orders of the logged-in user
// @access  Authenticated User
// -----------------------------------------------------------------------------
router.get(
  '/',
  authenticate,
  getUserOrders
);

// -----------------------------------------------------------------------------
// @route   GET /api/orders/all
// @desc    Get all orders (Admin only)
// @access  Admin
// -----------------------------------------------------------------------------
router.get(
  '/all',
  authenticate,
  authorizeAdminOnly,
  getOrders
);

// -----------------------------------------------------------------------------
// @route   GET /api/orders/:id
// @desc    Get a specific order by ID (owner or admin)
// @access  Authenticated User (must own the order) or Admin
// -----------------------------------------------------------------------------
router.get(
  '/:id',
  authenticate,
  validateOrderIdParam,
  validateRequest,
  getOrderById
);

module.exports = router;
