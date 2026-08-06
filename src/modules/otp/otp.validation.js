const { body } = require('express-validator');

exports.validateSendOtp = [
  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .custom((value) => {
      const cleanValue = value.replace(/\s+/g, '');
      if (!/^\+91\d{10}$/.test(cleanValue)) {
        throw new Error(
          'Phone must be a valid Indian number starting with +91'
        );
      }
      return true;
    }),
];

exports.validateVerifyOtp = [
  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+91\s?\d{10}$/)
    .withMessage('Phone must be a valid Indian number starting with +91'),

  body('otp')
    .trim()
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be exactly 6 digits')
    .isNumeric()
    .withMessage('OTP must contain only numbers'),
];
