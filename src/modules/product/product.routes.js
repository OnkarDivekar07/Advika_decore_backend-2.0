const express = require('express');
const router = express.Router();

const {
  getAllProducts,
  getProductById,
  getProductsByIds,
  getRelatedProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('./product.controller');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const upload = require('@config/multer');
const validateRequest = require('@middlewares/validateRequest');

const {
  validateCreateProduct,
  validateUpdateProduct,
  validateGetProductsByIds,
} = require('./product.validation');

// Public Routes

/**
 * @route   GET /api/products
 * @desc    Get all products
 * @access  Public
 */
router.get('/', getAllProducts);

/**
 * @route   GET /api/products/batch
 * @desc    Get multiple products by id (used to revalidate a guest cart's
 *          price/stock/availability against live data)
 * @access  Public
 *
 * Registered ahead of /:id so "batch" is never swallowed as an id param.
 */
router.get('/batch', validateGetProductsByIds, validateRequest, getProductsByIds);

/**
 * @route   GET /api/products/:id
 * @desc    Get product by ID
 * @access  Public
 */
router.get('/:id', getProductById);

/**
 * @route   GET /api/products/:id/related
 * @desc    Get related products
 * @access  Public
 */
router.get('/:id/related', getRelatedProducts);

// Admin-only Routes
router.use(authenticate, authorizeAdminOnly);

// /**
//  * @route   POST /api/products
//  * @desc    Create a new product
//  * @access  Admin
//  */
router.post(
  '/',
  upload.array('images', 5),
  validateCreateProduct,
  validateRequest,
  createProduct
);

/**
 * @route   PUT /api/products/:id
 * @desc    Update product
 * @access  Admin
 */
router.patch(
  '/:id',
  upload.array('images', 5),
  validateUpdateProduct,
  validateRequest,
  updateProduct
);

/**
 * @route   DELETE /api/products/:id
 * @desc    Delete a product
 * @access  Admin
 */
router.delete('/:id', deleteProduct);

module.exports = router;
