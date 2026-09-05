const { body, param } = require('express-validator');

// Indian mobile numbers only: E.164 form, +91 followed by 10 digits whose
// first digit is 6-9 (TRAI numbering plan) — kept in lockstep with the
// frontend's own PHONE_REGEX (src/utils/phoneValidation.js) and the otp
// module's validator (src/modules/otp/otp.validation.js), so a value that
// passes on the client is never surprised by a stricter check here.
const INDIAN_MOBILE_E164_REGEX = /^\+91[6-9]\d{9}$/;

// Indian PIN codes: exactly 6 digits, first digit 1-9 — shared with
// shipping.validation.js / shipping.service.js so every pincode format
// check in the app (address form, serviceability route, server-side
// defense-in-depth) agrees on the same definition. See
// src/constants/pincode.js for the full rationale.
const { INDIAN_PINCODE_REGEX } = require('@constants/pincode');

const phoneField = (required) => {
  let chain = body('phone');
  chain = required
    ? chain.notEmpty().withMessage('Mobile number is required').bail()
    : chain.optional();
  return chain
    .customSanitizer((value) => String(value ?? '').replace(/\s+/g, ''))
    .matches(INDIAN_MOBILE_E164_REGEX)
    .withMessage('Enter a valid 10-digit Indian mobile number');
};

const pincodeField = (required) => {
  // .trim() before the format check — matches shipping.validation.js's
  // validateServiceabilityCheck exactly (its own comment calls this field
  // "shared" with this one), so a pincode with incidental leading/trailing
  // whitespace isn't rejected here while that route would have accepted
  // the same value after trimming it.
  let chain = body('pincode').trim();
  chain = required
    ? chain.notEmpty().withMessage('Pincode is required').bail()
    : chain.optional();
  return chain
    .matches(INDIAN_PINCODE_REGEX)
    .withMessage('Enter a valid 6-digit Indian pincode');
};

const createAddressValidator = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 80 })
    .withMessage('Name must be between 2 and 80 characters'),
  phoneField(true),
  pincodeField(true),
  body('city')
    .trim()
    .notEmpty()
    .withMessage('City is required')
    .isLength({ max: 80 }),
  body('state')
    .trim()
    .notEmpty()
    .withMessage('State is required')
    .isLength({ max: 80 }),
  body('houseArea')
    .trim()
    .notEmpty()
    .withMessage('House / building / street is required')
    .isLength({ max: 200 })
    .withMessage('House / building / street must be under 200 characters'),
  body('area')
    .trim()
    .notEmpty()
    .withMessage('Area / locality is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Area / locality must be between 2 and 100 characters'),
  body('landmark')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Landmark must be between 2 and 100 characters'),
  body('deliveryInstructions')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Delivery instructions must be under 200 characters'),
  body('isDefault')
    .optional()
    .isBoolean()
    .withMessage('isDefault must be true or false')
    .toBoolean(),
];

const updateAddressValidator = [
  body('name').optional().trim().isLength({ min: 2, max: 80 }),
  phoneField(false),
  pincodeField(false),
  body('city').optional().trim().isLength({ min: 1, max: 80 }),
  body('state').optional().trim().isLength({ min: 1, max: 80 }),
  body('houseArea').optional().trim().isLength({ min: 1, max: 200 }),
  body('area').optional().trim().isLength({ min: 2, max: 100 }),
  body('landmark')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 100 }),
  body('deliveryInstructions')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 }),
  body('isDefault')
    .optional()
    .isBoolean()
    .withMessage('isDefault must be true or false')
    .toBoolean(),
];

const addressIdParamValidator = [
  param('id').notEmpty().withMessage('Address id is required'),
];

// For PATCH /api/user/profile — name, vehicle and dateOfBirth are the
// editable fields here (see user.service.js#updateUserProfile for why
// email/phone aren't). `name` is optional at the validation layer — the
// Login screen's signup "Create account" step (Login.dc.html Step 3)
// PATCHes just `{ vehicle }` when the driver fills in a vehicle but
// leaves the name field blank, and updateUserProfile already treats an
// absent `name` as "don't touch it" (Prisma ignores an undefined field
// in `data`). The Account page's own "Edit Profile" form still enforces
// a non-empty name client-side before it ever PATCHes.
// Truck/Pickup/Tempo/Tractor — mirrors the Login screen's signup vehicle
// picker (Login.dc.html Step 3) and design_handoff_advika_auto/README.md's
// vehicle-class vocabulary.
const VALID_VEHICLES = ['Truck', 'Pickup', 'Tempo', 'Tractor'];

const updateProfileValidator = [
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 80 })
    .withMessage('Name must be between 2 and 80 characters'),

  body('vehicle')
    .optional({ nullable: true })
    .isIn(VALID_VEHICLES)
    .withMessage(`vehicle must be one of ${VALID_VEHICLES.join(', ')}`),

  body('dateOfBirth')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('dateOfBirth must be a valid date (YYYY-MM-DD)'),
];

module.exports = {
  createAddressValidator,
  updateAddressValidator,
  addressIdParamValidator,
  updateProfileValidator,
};
