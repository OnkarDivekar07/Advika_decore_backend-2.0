// src/constants/pincode.js
//
// Indian PIN codes: exactly 6 digits, first digit 1-9 (no Indian postal
// zone starts with 0). This is the ONE place that shape rule lives —
// user.validation.js's address form check and shipping.validation.js's
// /serviceability route check both import it, and shipping.service.js
// re-checks it server-side as a defense-in-depth guard for callers that
// invoke checkServiceability() directly (e.g. order.service.js's
// detectAddressConflict at order-confirmation time, which never goes
// through the express-validator middleware chain at all). One shared
// regex means a value accepted as "well-formed" in one place is never
// surprised by a stricter or looser copy somewhere else.
//
// Deliberately not express-validator's isPostalCode('IN'), which only
// checks digit-count shape and would accept a leading-zero value that
// can't be a real Indian PIN code (e.g. '012345').
const INDIAN_PINCODE_REGEX = /^[1-9][0-9]{5}$/;

/**
 * @param {unknown} pincode
 * @returns {boolean} true only for a well-formed 6-digit Indian pincode
 *   string (after trimming whitespace) — says nothing about whether that
 *   pincode is real or serviceable, only that it's shaped like one.
 */
const isValidIndianPincodeFormat = (pincode) =>
  typeof pincode === 'string' && INDIAN_PINCODE_REGEX.test(pincode.trim());

module.exports = { INDIAN_PINCODE_REGEX, isValidIndianPincodeFormat };
