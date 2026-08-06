// Barrel file to export all payment modules

module.exports = {
  controller: require('./payment.controller'),
  service: require('./payment.service'),
  model: require('./payment.model'),
  routes: require('./payment.routes'),
  validation: require('./payment.validation'),
};
