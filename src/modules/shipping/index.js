// Barrel file to export all shipping modules

module.exports = {
  controller: require('./shipping.controller'),
  service: require('./shipping.service'),
  model: require('./shipping.model'),
  routes: require('./shipping.routes'),
  validation: require('./shipping.validation'),
};
