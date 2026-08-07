const express = require('express');
const router = express.Router();

const {
  checkServiceability,
  createShipment,
  trackShipment,
  cancelShipment,
  ekartWebhook,
} = require('./shipping.controller');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const validateRequest = require('@middlewares/validateRequest');
const {
  validateServiceabilityCheck,
  validateOrderIdParam,
  validateCancelShipment,
} = require('./shipping.validation');

/**
 * @route   POST /api/shipping/webhook
 * @desc    Ekart shipment status webhook — source of truth for delivery status
 * @access  Public (Ekart calls this directly; authenticated by HMAC
 *          signature inside the controller, not by a user JWT, so it must
 *          be registered before the `authenticate` middleware below)
 */
router.post('/webhook', ekartWebhook);

/**
 * @route   POST /api/shipping/serviceability
 * @desc    Check pincode serviceability + delivery estimate
 * @access  Public (shown on product/checkout pages before login)
 */
router.post(
  '/serviceability',
  validateServiceabilityCheck,
  validateRequest,
  checkServiceability
);

// Protect all remaining shipping routes
router.use(authenticate);

/**
 * @route   POST /api/shipping/:orderId/create
 * @desc    Manually trigger shipment creation for a confirmed order
 * @access  Admin
 */
router.post(
  '/:orderId/create',
  authorizeAdminOnly,
  validateOrderIdParam,
  validateRequest,
  createShipment
);

/**
 * @route   GET /api/shipping/:orderId/track
 * @desc    Get the latest tracking status for an order's shipment
 * @access  Authenticated User (owner) or Admin
 */
router.get(
  '/:orderId/track',
  validateOrderIdParam,
  validateRequest,
  trackShipment
);

/**
 * @route   POST /api/shipping/:orderId/cancel
 * @desc    Cancel a shipment before it's out for delivery
 * @access  Authenticated User (owner) or Admin
 */
router.post(
  '/:orderId/cancel',
  validateCancelShipment,
  validateRequest,
  cancelShipment
);

module.exports = router;
