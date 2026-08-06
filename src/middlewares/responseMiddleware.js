// middlewares/responseMiddleware.js
const sendResponse = require('@utils/sendResponse');

const responseMiddleware = (req, res, next) => {
  res.sendResponse = (options) => sendResponse(res, options);
  next();
};

module.exports = responseMiddleware;
