// Barrel file to export all inventory modules

module.exports = {
  controller: require('./inventory.controller'),
  service: require('./inventory.service'),
  model: require('./inventory.model'),
  routes: require('./inventory.routes'),
  validation: require('./inventory.validation'),
};