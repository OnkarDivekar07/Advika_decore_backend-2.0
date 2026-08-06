const { body } = require("express-validator");

exports.validateCreateOrderId = [
  // Nothing specific needed here since we use the user's session (auth)
];

exports.validateVerifyPayment = [
  body("razorpay_order_id")
    .notEmpty()
    .withMessage("Razorpay order ID is required"),

  body("razorpay_payment_id")
    .notEmpty()
    .withMessage("Razorpay payment ID is required"),

  body("razorpay_signature")
    .notEmpty()
    .withMessage("Razorpay signature is required"),
];

exports.validateCODOrder = [
  body("orderId")
    .notEmpty()
    .withMessage("Order ID is required")
    .isString()
    .withMessage("Order ID must be a string"),

  body("method")
    .equals("cod")
    .withMessage("Method must be 'cod'"),
];
