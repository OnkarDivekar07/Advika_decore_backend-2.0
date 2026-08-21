const express = require('express');
const router = express.Router();

const {
  getStats,
  getAllUsersWithStats,
  getUserById,
  loginAdmin,
  getCurrentAdmin,
  getAnalyticsOverview,
  getRevenueTrend,
  getOperationalAlerts,
} = require('./admin.controller');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const { adminLoginRateLimiter } = require('@middlewares/rateLimiter');
const {
  validateAdminQueries,
  validateAdminLogin,
  validateUserIdParam,
  validateAnalyticsOverviewQuery,
  validateRevenueTrendQuery,
  validateOperationalAlertsQuery,
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

/**
 * @route   GET /api/admin/users/:id
 * @desc    Get a single customer's detail view (profile, all addresses,
 *          recent order history, and full-history order totals). Never
 *          returns password/OTP/auth-secret/payment-secret fields — see
 *          admin.service.js's getUserDetailById, which only ever reads
 *          via a Prisma `select`.
 * @access  Admin
 */
router.get('/users/:id', validateUserIdParam, validateRequest, getUserById);

/**
 * @route   GET /api/admin/analytics/overview
 * @desc    PHASE 11 — date-range-scoped KPI summary (gross revenue, order/
 *          customer/product counts, delivered/pending counts, average
 *          order value). Complements, and never replaces, GET /stats'
 *          all-time snapshot. Every field's exact backend definition ships
 *          in the response's own `definitions` object — see
 *          admin.analytics.service.js.
 * @access  Admin
 */
router.get(
  '/analytics/overview',
  validateAnalyticsOverviewQuery,
  validateRequest,
  getAnalyticsOverview
);

/**
 * @route   GET /api/admin/analytics/revenue-trend
 * @desc    PHASE 11 — chartable, MongoDB-aggregated paid-revenue time
 *          series bucketed by day/week/month. Defaults to a trailing
 *          30-day window when no dateFrom/dateTo is given (see
 *          admin.analytics.service.js's getRevenueTrend); the resolved
 *          window is always echoed back in the response's `range`.
 * @access  Admin
 */
router.get(
  '/analytics/revenue-trend',
  validateRevenueTrendQuery,
  validateRequest,
  getRevenueTrend
);

/**
 * @route   GET /api/admin/alerts
 * @desc    PHASE 14 — operational "needs attention" feed: low-stock
 *          products, orders still awaiting confirmation, payment attempts
 *          that need a human look, and shipment failures/RTOs. Every
 *          section is a live read of real Order/Product/Shipment state —
 *          see admin.service.js's getOperationalAlerts. Optional
 *          ?lowStockThreshold= (default 10, same meaning as
 *          GET /api/inventory/low-stock's own threshold).
 * @access  Admin
 */
router.get(
  '/alerts',
  validateOperationalAlertsQuery,
  validateRequest,
  getOperationalAlerts
);

module.exports = router;
