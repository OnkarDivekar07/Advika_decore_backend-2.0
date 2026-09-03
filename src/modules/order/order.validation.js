const { body, param, query } = require('express-validator');

const mongoose = require('mongoose');

// Upper bound on a Buy Now line item's quantity — same cheap input-sanity
// guard cart.validation.js uses for cart quantities (MAX_CART_QUANTITY).
// The real limit is always the live stock check in order.service.js.
const MAX_BUY_NOW_QUANTITY = 10000;

const validateDraftOrder = [
  body('selectedAddressId')
    .trim()
    .notEmpty()
    .withMessage('Address ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),

  // Optional — see calculateDiscount in src/constants/pricing.js. Only
  // shape-validated here; whether the code actually resolves to anything
  // is a service-layer concern (no coupons exist yet, so any code fails
  // there with a 404), not a request-validation one.
  body('couponCode')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('couponCode must be a string')
    .bail()
    .trim()
    .isLength({ max: 64 })
    .withMessage('couponCode is too long'),

  // Optional "Buy Now" line item — when present, the draft order is built
  // from this single product instead of the user's cart (see
  // order.service.js). Only shape/type-validated here; whether the
  // product exists, is still active, and has enough stock is re-checked
  // server-side at draft-order time exactly like every cart item is, so
  // Buy Now can never skip that re-validation the way the old
  // frontend-only Buy Now flow did.
  body('buyNow')
    .optional({ nullable: true })
    .isObject()
    .withMessage('buyNow must be an object'),

  body('buyNow.productId')
    .if(body('buyNow').exists())
    .trim()
    .notEmpty()
    .withMessage('buyNow.productId is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format for buyNow.productId'),

  body('buyNow.quantity')
    .if(body('buyNow').exists())
    .isInt({ min: 1, max: MAX_BUY_NOW_QUANTITY })
    .withMessage(
      `buyNow.quantity must be an integer between 1 and ${MAX_BUY_NOW_QUANTITY}`
    )
    .toInt(),
];

// GET /api/orders/history — page/limit are optional; service-level
// defaults/caps (see order.service.js's ORDER_HISTORY_DEFAULT_LIMIT /
// ORDER_HISTORY_MAX_LIMIT) still apply even if this middleware is ever
// bypassed, but validating here means a bad value 422s with a clear
// message instead of just being silently clamped.
const validateOrderHistoryQuery = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be an integer between 1 and 50')
    .toInt(),
];

const validateOrderIdParam = [
  param('id')
    .trim()
    .notEmpty()
    .withMessage('Order ID is required')
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage('Invalid MongoDB ObjectId format'),
];

// POST /api/orders/:id/cancel — the id param is validated the same way as
// every other :id route (validateOrderIdParam); `reason` is optional and
// only ever used for the log line in order.service.js's
// cancelOrderByCustomer, never shown back to the customer or any other
// user, so it's length-capped purely as input hygiene, not sanitized for
// display.
const validateCancelOrder = [
  ...validateOrderIdParam,
  body('reason')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('reason must be a string')
    .bail()
    .trim()
    .isLength({ max: 500 })
    .withMessage('reason is too long'),
];

// POST /api/orders/:id/refund (Admin) — same shape as validateCancelOrder
// (id param + optional bounded `reason`); kept separate rather than reused
// so the two can diverge later without one silently affecting the other.
const validateRefundOrder = [
  ...validateOrderIdParam,
  body('reason')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('reason must be a string')
    .bail()
    .trim()
    .isLength({ max: 500 })
    .withMessage('reason is too long'),
];

// GET /api/orders/all (Admin) — the order workbench's list query. Every
// filter here is optional; an admin with no filters selected still gets a
// paginated (never unbounded) list — see order.service.js's
// ORDER_LIST_DEFAULT_LIMIT/ORDER_LIST_MAX_LIMIT.
//
// 'draft' is deliberately excluded from the allowed `status` values: a
// draft order is an in-progress cart/checkout-in-flight row, never
// something a customer actually placed, and order.service.js's
// getAllOrders already always excludes it from the base (unfiltered)
// query for the same reason — there is no admin-facing "show me drafts"
// use case to support.
const ADMIN_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
];
const ADMIN_PAYMENT_STATUSES = [
  'pending',
  'attempted',
  'processing',
  'paid',
  'failed',
  'cancelled',
  'timeout',
  'unknown',
  'refunded',
  'cod_pending',
];

const validateOrderListQuery = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer')
    .toInt(),

  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be an integer between 1 and 100')
    .toInt(),

  query('status')
    .optional()
    .isIn(ADMIN_ORDER_STATUSES)
    .withMessage(`status must be one of: ${ADMIN_ORDER_STATUSES.join(', ')}`),

  query('paymentStatus')
    .optional()
    .isIn(ADMIN_PAYMENT_STATUSES)
    .withMessage(
      `paymentStatus must be one of: ${ADMIN_PAYMENT_STATUSES.join(', ')}`
    ),

  query('dateFrom')
    .optional()
    .isISO8601()
    .withMessage('dateFrom must be a valid ISO 8601 date')
    .toDate(),

  query('dateTo')
    .optional()
    .isISO8601()
    .withMessage('dateTo must be a valid ISO 8601 date')
    .toDate(),

  // Matches against customer name/email, and against the order id itself
  // when the term is shaped like one — see order.service.js's
  // getAllOrders. Length-capped purely as basic input hygiene.
  query('search')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 128 })
    .withMessage('search must be at most 128 characters'),
];

module.exports = {
  validateDraftOrder,
  validateOrderHistoryQuery,
  validateOrderIdParam,
  validateOrderListQuery,
  validateCancelOrder,
  validateRefundOrder,
  ADMIN_ORDER_STATUSES,
  ADMIN_PAYMENT_STATUSES,
  MAX_BUY_NOW_QUANTITY,
};
