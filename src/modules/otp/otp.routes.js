const express = require('express');
const router = express.Router();

const { sendOtp, verifyOtp } = require('./otp.controller');
const { validateSendOtp, validateVerifyOtp } = require('./otp.validation');
const validateRequest = require('@middlewares/validateRequest');
const otpRateLimiter = require('@middlewares/rateLimiter');
const { otpVerifyRateLimiter } = otpRateLimiter;

/**
 * @route   POST /api/otp/send-otp
 * @desc    Send OTP to user phone
 * @access  Public
 */
router.post(
  '/send-otp',
  otpRateLimiter,
  validateSendOtp,
  validateRequest,
  sendOtp
);

/**
 * @route   POST /api/otp/verify-otp
 * @desc    Verify OTP and login or register user
 * @access  Public
 */
router.post(
  '/verify-otp',
  otpVerifyRateLimiter,
  validateVerifyOtp,
  validateRequest,
  verifyOtp
);

module.exports = router;
