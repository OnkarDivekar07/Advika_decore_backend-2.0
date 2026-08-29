const express = require('express');
const router = express.Router();

const { getAllContent, upsertContent } = require('./content.controller');
const { validateUpsertContent } = require('./content.validation');

const validateRequest = require('@middlewares/validateRequest');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');

/**
 * @route   GET /api/content
 * @desc    Get all admin-editable storefront text (ticker, category labels,
 *          footer info, ...), trilingual
 * @access  Public — the storefront itself is the primary reader
 */
router.get('/', getAllContent);

/**
 * @route   PATCH /api/content/:key
 * @desc    Create or update one content key's English/Hindi/Marathi text
 * @access  Admin
 */
router.patch(
  '/:key',
  authenticate,
  authorizeAdminOnly,
  validateUpsertContent,
  validateRequest,
  upsertContent
);

module.exports = router;
