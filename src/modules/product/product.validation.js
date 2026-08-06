const { body } = require('express-validator');

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
