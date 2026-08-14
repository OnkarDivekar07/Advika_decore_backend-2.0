const express = require('express');
const router = express.Router();

const {
  createAddress,
  getAddresses,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getUserProfile,
  updateProfile,
  sendPhoneChangeOtp,
  verifyPhoneChangeOtp,
} = require('./user.controller');

const authenticate = require('@middlewares/authenticate');
const {
  createAddressValidator,
  updateAddressValidator,
  addressIdParamValidator,
  updateProfileValidator,
} = require('./user.validation');

// Reused as-is (not re-implemented) for the change-mobile-number flow's
// request shape — same "phone must be a valid +91 number" / "otp must be
// 6 digits" rules the login OTP flow already enforces (see
// otp.validation.js). Rate limiting also reuses the same limiters login
// uses (otpRateLimiter / otpVerifyRateLimiter), keyed per-phone, so a
// change-number attempt can't be used to dodge the send/verify attempt
// caps that apply everywhere else OTPs are sent.
const { validateSendOtp, validateVerifyOtp } = require('@modules/otp/otp.validation');
const { otpRateLimiter, otpVerifyRateLimiter } = require('@middlewares/rateLimiter');

const validateRequest = require('@middlewares/validateRequest');

// Protect all address routes under user
router.use(authenticate);

/**
 * @route   POST /api/user/address
 * @desc    Create a new delivery address for the logged-in user
 * @access  User
 */
router.post('/address', createAddressValidator, validateRequest, createAddress);

/**
 * @route   GET /api/user/addresses
 * @desc    Get all delivery addresses for the logged-in user
 * @access  User
 */
router.get('/addresses', getAddresses);

/**
 * @route   PUT /api/user/address/:id
 * @desc    Update a delivery address by ID
 * @access  User
 */
router.put('/address/:id', updateAddressValidator, validateRequest, updateAddress);

/**
 * @route   DELETE /api/user/address/:id
 * @desc    Delete a delivery address by ID
 * @access  User
 */
router.delete('/address/:id', addressIdParamValidator, validateRequest, deleteAddress);

/**
 * @route   PATCH /api/user/address/:id/default
 * @desc    Mark a delivery address as the default for the logged-in user
 * @access  User
 */
router.patch('/address/:id/default', addressIdParamValidator, validateRequest, setDefaultAddress);


router.get('/profile', getUserProfile);

/**
 * @route   PATCH /api/user/profile
 * @desc    Update the logged-in user's display name
 * @access  User
 */
router.patch('/profile', updateProfileValidator, validateRequest, updateProfile);

/**
 * @route   POST /api/user/phone/send-otp
 * @desc    Send an OTP to a new mobile number (step 1 of changing phone)
 * @access  User
 */
router.post(
  '/phone/send-otp',
  otpRateLimiter,
  validateSendOtp,
  validateRequest,
  sendPhoneChangeOtp
);

/**
 * @route   POST /api/user/phone/verify-otp
 * @desc    Verify the OTP and update the logged-in user's phone (step 2)
 * @access  User
 */
router.post(
  '/phone/verify-otp',
  otpVerifyRateLimiter,
  validateVerifyOtp,
  validateRequest,
  verifyPhoneChangeOtp
);

module.exports = router;
