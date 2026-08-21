const { query, check, param } = require('express-validator');
const mongoose = require('mongoose');

const validateAdminQueries = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be an integer greater than 0'),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),

  query('sort')
    .optional()
    .isIn(['createdAt', 'name', 'email'])
    .withMessage('Sort must be one of createdAt, name, email'),

  query('order')
    .optional()
    .isIn(['asc', 'desc'])
    .withMessage('Order must be asc or desc'),

  query('role')
    .optional()
    .isIn(['customer', 'admin', 'superadmin'])
    .withMessage('Role must be user, admin, or superadmin'),

  // Minimal admin query extension (see admin.service.js's
  // getAllUsersWithStats) — matched against name/email/phone. Length-capped
  // as basic input hygiene, same convention as order.validation.js's
  // own `search` field.
  query('search')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Search must be 100 characters or fewer'),
];

// PHASE 11 — shared dateFrom/dateTo shape for both analytics endpoints.
// Mirrors order.validation.js's own validateOrderListQuery dateFrom/dateTo
// rules (same ISO8601 check) for consistency across the admin panel's date
// filters, without importing across modules.
const validateAnalyticsDateRange = [
  query('dateFrom')
    .optional()
    .isISO8601()
    .withMessage('dateFrom must be a valid ISO 8601 date'),

  query('dateTo')
    .optional()
    .isISO8601()
    .withMessage('dateTo must be a valid ISO 8601 date')
    // Cross-field check: only meaningful once we know dateFrom parsed too,
    // so this stays a plain custom validator rather than two independent
    // isISO8601 checks that can't see each other.
    .custom((value, { req }) => {
      if (!req.query.dateFrom) return true;
      const from = new Date(req.query.dateFrom);
      const to = new Date(value);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return true; // already flagged individually
      if (to < from) {
        throw new Error('dateTo must not be before dateFrom');
      }
      return true;
    }),
];

const validateAnalyticsOverviewQuery = [...validateAnalyticsDateRange];

const validateRevenueTrendQuery = [
  ...validateAnalyticsDateRange,
  query('granularity')
    .optional()
    .isIn(['day', 'week', 'month'])
    .withMessage('granularity must be one of day, week, month'),
];

const validateUserIdParam = [
  param('id')
    .trim()
    .notEmpty()
    .withMessage('User ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
];

// PHASE 14 — GET /api/admin/alerts. Mirrors inventory.validation.js's own
// validateLowStockQuery (same field, same rule) so the threshold behaves
// identically whether it's applied from Inventory.jsx or from the alerts
// panel — not re-imported across modules, same as validateAnalyticsDateRange
// above intentionally isn't shared with order.validation.js.
const validateOperationalAlertsQuery = [
  query('lowStockThreshold')
    .optional()
    .isInt({ min: 0 })
    .withMessage('lowStockThreshold must be a non-negative integer')
    .toInt(),
];

const validateAdminLogin = [
  check('email')
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Must be a valid email'),

  check('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
];

module.exports = {
  validateAdminQueries,
  validateAdminLogin,
  validateUserIdParam,
  validateAnalyticsOverviewQuery,
  validateRevenueTrendQuery,
  validateOperationalAlertsQuery,
};
