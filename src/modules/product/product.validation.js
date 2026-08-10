const { body, query } = require('express-validator');

// Upper bound on how many ids a single batch lookup can request. This is a
// public, unauthenticated endpoint (see GET /api/products/batch), so it
// needs its own sanity ceiling independent of anything cart-side — a
// generous cap for a real cart (which is itself capped by
// cart.validation's MAX_CART_QUANTITY only on quantity, not line-item
// count) while still blocking an obviously abusive query string.
const MAX_BATCH_IDS = 50;

// For GET /api/products/batch (getProductsByIds) — used by the frontend to
// revalidate a guest (localStorage-only) cart's prices/stock/availability
// against live product data, since a guest cart has no backend row for
// cart.service's assertProductAvailable to guard.
exports.validateGetProductsByIds = [
  query('ids')
    .exists({ checkFalsy: true })
    .withMessage('ids is required')
    .isString()
    .withMessage('ids must be a comma-separated string of product ids')
    .customSanitizer((value) =>
      Array.from(new Set(value.split(',').map((id) => id.trim()).filter(Boolean)))
    )
    .custom((ids) => {
      if (ids.length === 0) {
        throw new Error('ids must contain at least one product id');
      }
      if (ids.length > MAX_BATCH_IDS) {
        throw new Error(`ids cannot contain more than ${MAX_BATCH_IDS} product ids`);
      }
      return true;
    }),
];

exports.MAX_BATCH_IDS = MAX_BATCH_IDS;

exports.validateCreateProduct = [
  body('name')
    .exists({ checkFalsy: true })
    .withMessage('Product name is required')
    .isString()
    .withMessage('Product name must be a string')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Product name must be 2 to 100 characters')
    .matches(/^[a-zA-Z0-9\s\-&.,/()]+$/)
    .withMessage('Product name contains invalid characters')
    .matches(/[a-zA-Z]/)
    .withMessage('Product name must contain at least one letter'),

  body('brand')
    .exists({ checkFalsy: true })
    .withMessage('Brand is required')
    .isString()
    .withMessage('Brand must be a string')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Brand must be between 2 and 50 characters')
    .matches(/^[a-zA-Z0-9\s\-&.()]+$/)
    .withMessage('Brand contains invalid characters')
    .matches(/[a-zA-Z]/)
    .withMessage('Brand must contain at least one letter'),

  body('price')
    .exists({ checkFalsy: true })
    .withMessage('Price is required')
    .isFloat({ gt: 0 })
    .withMessage('Price must be a number greater than 0')
    .toFloat(),

  body('stock')
    .exists({ checkFalsy: true })
    .withMessage('Stock is required')
    .isInt({ min: 0 })
    .withMessage('Stock must be a non-negative integer')
    .toInt(),

  body('description').trim().notEmpty().withMessage('Description is required'),

  body('category').custom((value, { req }) => {
    const category = req.body.category;
    if (!category || (Array.isArray(category) && category.length === 0)) {
      throw new Error('At least one category is required');
    }
    return true;
  }),

  body('isNewArrival')
    .optional()
    .isBoolean()
    .withMessage('isNewArrival must be a boolean')
    .toBoolean(),
];

exports.validateUpdateProduct = [
  body('name')
    .optional()
    .isString()
    .withMessage('Product name must be a string')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Product name must be 2 to 100 characters')
    .matches(/^[a-zA-Z0-9\s\-&.,/()]+$/)
    .withMessage('Product name contains invalid characters')
    .matches(/[a-zA-Z]/)
    .withMessage('Product name must contain at least one letter'),

  body('brand')
    .optional()
    .isString()
    .withMessage('Brand must be a string')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Brand must be between 2 and 50 characters')
    .matches(/^[a-zA-Z0-9\s\-&.()]+$/)
    .withMessage('Brand contains invalid characters')
    .matches(/[a-zA-Z]/)
    .withMessage('Brand must contain at least one letter'),

  body('price')
    .optional()
    .isFloat({ gt: 0 })
    .withMessage('Price must be a number greater than 0')
    .toFloat(),

  body('stock')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Stock must be a non-negative integer')
    .toInt(),

  body('description')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Description cannot be empty if provided'),

  body('category')
    .optional()
    .custom((value, { req }) => {
      if (Array.isArray(value) && value.length === 0) {
        throw new Error('At least one category is required');
      }
      return true;
    }),

  body('isNewArrival')
    .optional()
    .isBoolean()
    .withMessage('isNewArrival must be a boolean')
    .toBoolean(),
];
