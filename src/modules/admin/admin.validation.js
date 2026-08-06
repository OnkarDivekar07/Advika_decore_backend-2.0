const { query, check } = require('express-validator');

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

module.exports = { validateAdminQueries, validateAdminLogin };
