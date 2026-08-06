const { body, query } = require('express-validator');

exports.createBannerValidator = [
  body('linkUrl').optional().isURL().withMessage('linkUrl must be a valid URL'),
];

exports.validateNewArrivals = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be an integer greater than 0'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be an integer between 1 and 100'),
];
