// Barrel file to export all otp modules

module.exports = {
  controller: require('./otp.controller'),
  service: require('./otp.service'),
  model: require('./otp.model'),
  routes: require('./otp.routes'),
  validation: require('./otp.validation'),
};
