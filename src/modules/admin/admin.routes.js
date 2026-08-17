const express = require('express');
const router = express.Router();

const {
  getStats,
  getAllUsersWithStats,
  loginAdmin,
  getCurrentAdmin,
} = require('./admin.controller');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const { adminLoginRateLimiter } = require('@middlewares/rateLimiter');
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
router.post(
  '/login',
  adminLoginRateLimiter,
  validateAdminLogin,
  validateRequest,
  loginAdmin
);

// Protect all admin routes
router.use(authenticate, authorizeAdminOnly);

/**
 * @route   GET /api/admin/me
 * @desc    Re-verify the current session against the database and return
 *          the current admin's profile. Used by the admin panel on
 *          load/refresh so a stored token is never treated as proof of
 *          authorization by itself.
 * @access  Admin
 */
router.get('/me', getCurrentAdmin);

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
