// Barrel file to export all order modules

module.exports = {
  controller: require('./order.controller'),
  service: require('./order.service'),
  model: require('./order.model'),
  routes: require('./order.routes'),
  validation: require('./order.validation'),
};
