// Normalizes to the bare 10-digit form phone numbers are stored in (see
// prisma/schema.prisma + prisma/seed.js: no "+91"/country-code prefix) —
// strips all non-digits, then drops a leading country code if present by
// keeping only the last 10 digits.
const normalizePhone = (phone) => {
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;
};

module.exports = normalizePhone;
