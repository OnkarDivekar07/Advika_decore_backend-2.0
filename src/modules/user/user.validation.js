const { body } = require('express-validator');

const createAddressValidator = [
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2 })
    .withMessage('Name must be at least 2 characters'),
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .isMobilePhone()
    .withMessage('Invalid phone number'),
  body('pincode')
    .notEmpty()
    .withMessage('Pincode is required')
    .isPostalCode('IN')
    .withMessage('Invalid Indian pincode'),
  body('city').notEmpty().withMessage('City is required'),
  body('state').notEmpty().withMessage('State is required'),
  body('houseArea').notEmpty().withMessage('House area is required'),
  body('landmark')
    .optional()
    .isLength({ min: 2 })
    .withMessage('Landmark must be at least 2 characters'),
];

const updateAddressValidator = [
  body('name').optional().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('pincode').optional().isPostalCode('IN'),
  body('city').optional().isLength({ min: 1 }),
  body('state').optional().isLength({ min: 1 }),
  body('houseArea').optional().isLength({ min: 1 }),
  body('landmark').optional().isLength({ min: 2 }),
];

module.exports = {
  createAddressValidator,
  updateAddressValidator,
};
