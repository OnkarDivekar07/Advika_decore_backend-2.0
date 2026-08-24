const { validationResult } = require('express-validator');
const CustomError = require('@utils/customError');

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map((err) => ({
      field: err.param,
      message: err.msg,
    }));
    throw new CustomError('Validation failed', 422, errorDetails);
  }

  next();
};

module.exports = validateRequest;
