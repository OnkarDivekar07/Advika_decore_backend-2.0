// Barrel file to export all cart modules

module.exports = {
  controller: require('./cart.controller'),
  service: require('./cart.service'),
  model: require('./cart.model'),
  routes: require('./cart.routes'),
  validation: require('./cart.validation'),
};
