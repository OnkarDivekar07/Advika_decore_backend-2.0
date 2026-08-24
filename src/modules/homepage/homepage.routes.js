const express = require('express');
const router = express.Router();

const {
  getBanners,
  createBanner,
  deleteBanner,
  getNewArrivalProducts,
  softDeleteNewArrival,
} = require('./homepage.controller');

const upload = require('@config/multer');
const {
  createBannerValidator,
  validateNewArrivals,
} = require('./homepage.validation');

const validateRequest = require('@middlewares/validateRequest');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');

// PUBLIC ROUTES
/**
 * @route   GET /api/homepage/banners
 * @desc    Get all homepage banners
 * @access  Public
 */
router.get('/banners', getBanners);

/**
 * @route   GET /api/homepage/new-arrivals
 * @desc    Get all new arrivals
 * @access  Public
 */
router.get(
  '/new-arrivals',
  validateNewArrivals,
  validateRequest,
  getNewArrivalProducts
);

// PROTECTED ADMIN ROUTES
router.use(authenticate, authorizeAdminOnly);

/**
 * @route   POST /api/homepage/banners
 * @desc    Create a new homepage banner
 * @access  Admin
 */
router.post(
  '/banners',
  upload.single('image'),
  upload.handleUploadError,
  createBannerValidator,
  validateRequest,
  createBanner
);

/**
 * @route   DELETE /api/homepage/banners/:id
 * @desc    Delete a banner
 * @access  Admin
 */
router.delete('/banners/:id', deleteBanner);

/**
 * @route   PATCH /api/homepage/new-arrivals/:id
 * @desc    Soft delete a new arrival product
 * @access  Admin
 */
router.patch('/new-arrivals/:id', softDeleteNewArrival);

module.exports = router;
