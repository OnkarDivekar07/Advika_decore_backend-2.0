const normalizePhone = (phone) => {
  return phone.replace(/\D/g, ''); // remove all non-digits
};

module.exports = normalizePhone;
