// Barrel file to export all admin modules

module.exports = {
  controller: require('./admin.controller'),
  service: require('./admin.service'),
  model: require('./admin.model'),
  routes: require('./admin.routes'),
  validation: require('./admin.validation'),
};
