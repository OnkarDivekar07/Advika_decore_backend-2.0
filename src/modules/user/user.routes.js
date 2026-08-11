const express = require('express');
const router = express.Router();

const {
  createAddress,
  getAddresses,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getUserProfile
} = require('./user.controller');

const authenticate = require('@middlewares/authenticate');
const {
  createAddressValidator,
  updateAddressValidator,
  addressIdParamValidator,
} = require('./user.validation');

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


router.get('/profile',getUserProfile)




module.exports = router;
