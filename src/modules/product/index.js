// Barrel file to export all product modules

module.exports = {
  controller: require('./product.controller'),
  service: require('./product.service'),
  model: require('./product.model'),
  routes: require('./product.routes'),
  validation: require('./product.validation'),
};
