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
  chain = required ? chain.notEmpty().withMessage('Mobile number is required').bail() : chain.optional();
  return chain
    .customSanitizer((value) => String(value ?? '').replace(/\s+/g, ''))
    .matches(INDIAN_MOBILE_E164_REGEX)
    .withMessage('Enter a valid 10-digit Indian mobile number');
};

const pincodeField = (required) => {
  let chain = body('pincode');
  chain = required ? chain.notEmpty().withMessage('Pincode is required').bail() : chain.optional();
  return chain.matches(INDIAN_PINCODE_REGEX).withMessage('Enter a valid 6-digit Indian pincode');
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
  body('city').trim().notEmpty().withMessage('City is required').isLength({ max: 80 }),
  body('state').trim().notEmpty().withMessage('State is required').isLength({ max: 80 }),
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
  body('landmark').optional({ checkFalsy: true }).trim().isLength({ min: 2, max: 100 }),
  body('deliveryInstructions').optional({ checkFalsy: true }).trim().isLength({ max: 200 }),
  body('isDefault')
    .optional()
    .isBoolean()
    .withMessage('isDefault must be true or false')
    .toBoolean(),
];

const addressIdParamValidator = [param('id').notEmpty().withMessage('Address id is required')];

module.exports = {
  createAddressValidator,
  updateAddressValidator,
  addressIdParamValidator,
};
