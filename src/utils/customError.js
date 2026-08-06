// utils/CustomError.js
class CustomError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor); // cleaner stack trace
  }
}

module.exports = CustomError;
