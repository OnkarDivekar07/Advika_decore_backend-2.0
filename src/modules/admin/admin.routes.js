const express = require('express');
const router = express.Router();

const {
  getStats,
  getAllUsersWithStats,
  loginAdmin,
} = require('./admin.controller');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const {
  validateAdminQueries,
  validateAdminLogin,
} = require('./admin.validation');
const validateRequest = require('@middlewares/validateRequest');

/**
 * @swagger
 * /api/admin/login:
 * ...
 */
router.post('/login', validateAdminLogin, validateRequest, loginAdmin);

// Protect all admin routes
router.use(authenticate, authorizeAdminOnly);

/**
 * @route   GET /api/admin/stats
 * @desc    Get platform-wide statistics
 * @access  Admin
 */
router.get('/stats', getStats);

/**
 * @route   GET /api/admin/users
 * @desc    Get all users with purchase stats
 * @access  Admin
 */
router.get(
  '/users',
  validateAdminQueries,
  validateRequest,
  getAllUsersWithStats
);

module.exports = router;
