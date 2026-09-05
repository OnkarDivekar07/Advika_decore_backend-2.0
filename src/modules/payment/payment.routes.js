const express = require('express');
const router = express.Router();

const {
  createOrderid,
  verifyPayment,
  placeCODOrder,
  razorpayWebhook,
  cancelPayment,
} = require('./payment.controller');

const authenticate = require('@middlewares/authenticate');
const {
  validateVerifyPayment,
  validateCODOrder,
  validateCancelPayment,
} = require('./payment.validation');

const validateRequest = require('@middlewares/validateRequest');
const { paymentCreateOrderRateLimiter } = require('@middlewares/rateLimiter');

/**
 * @route   POST /api/payment/webhook
 * @desc    Razorpay webhook — source of truth for payment status
 * @access  Public (Razorpay calls this directly; authenticated by HMAC
 *          signature inside the controller, not by a user JWT, so it must
 *          be registered before the `authenticate` middleware below)
 */
router.post('/webhook', razorpayWebhook);

// Protect all remaining payment routes
router.use(authenticate);

/**
 * @route   POST /api/payment/create-orderid
 * @desc    Create a Razorpay Order ID
 * @access  Authenticated Users
 */
router.post('/create-orderid', paymentCreateOrderRateLimiter, createOrderid);

/**
 * @route   POST /api/payment/verify
 * @desc    Verify Razorpay Payment
 * @access  Authenticated Users
 */
router.post('/verify', validateVerifyPayment, validateRequest, verifyPayment);

/**
 * @route   POST /api/payment/cod
 * @desc    Place a Cash On Delivery order
 * @access  Authenticated Users
 */
router.post('/cod', validateCODOrder, validateRequest, placeCODOrder);

/**
 * @route   POST /api/payment/cancel
 * @desc    Cancel the caller's own in-flight payment attempt (e.g. the
 *          customer closed the Razorpay checkout modal) without cancelling
 *          the underlying draft order itself
 * @access  Authenticated Users
 */
router.post('/cancel', validateCancelPayment, validateRequest, cancelPayment);

module.exports = router;
