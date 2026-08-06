// utils/sendResponse.js

const sendResponse = (
  res,
  { success = true, statusCode = 200, message = '', data = null, meta = {} }
) => {
  return res.status(statusCode).json({
    success,
    message,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta,
    },
  });
};

module.exports = sendResponse;
