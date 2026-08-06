// utils/hashPassword.js
const bcrypt = require('bcrypt');

// Hash password
const hashPassword = async (password) => {
  const saltRounds = 10; // Salt rounds for bcrypt hashing
  return bcrypt.hash(password, saltRounds);
};

// Compare password
const comparePassword = async (password, hashedPassword) => {
  return bcrypt.compare(password, hashedPassword);
};

module.exports = { hashPassword, comparePassword };
