const { body, param } = require('express-validator');

// Dotted path matching the i18n key it overrides (e.g. "ticker.cod") —
// letters/digits/underscore/HYPHEN/dot only, so it can never collide with
// a route segment or be used to inject something unexpected into a lookup
// key. Hyphens are required, not just permissive: real keys use them
// (e.g. "category.steering-cover.label", matching
// frontend-improved/src/config/advikaAuto.js's kebab-case category ids) —
// caught the hard way when the original letters/digits/underscore-only
// version of this regex rejected every PATCH for those rows outright, even
// though the seed script had already written them fine (seeding writes
// directly via Prisma, bypassing this HTTP-layer validator entirely).
const CONTENT_KEY_REGEX = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

exports.validateContentKeyParam = [
  param('key')
    .trim()
    .notEmpty()
    .withMessage('Content key is required')
    .matches(CONTENT_KEY_REGEX)
    .withMessage(
      'Content key must be letters/numbers/underscores/hyphens separated by dots (e.g. "category.steering-cover.label")'
    ),
];

exports.validateUpsertContent = [
  ...exports.validateContentKeyParam,
  body('valueEn')
    .trim()
    .notEmpty()
    .withMessage('English text is required')
    .isLength({ max: 500 })
    .withMessage('Text must be 500 characters or fewer'),
  body('valueHi')
    .trim()
    .notEmpty()
    .withMessage('Hindi text is required')
    .isLength({ max: 500 })
    .withMessage('Text must be 500 characters or fewer'),
  body('valueMr')
    .trim()
    .notEmpty()
    .withMessage('Marathi text is required')
    .isLength({ max: 500 })
    .withMessage('Text must be 500 characters or fewer'),
];
