// Barrel file to export all user modules

module.exports = {
  controller: require('./user.controller'),
  service: require('./user.service'),
  model: require('./user.model'),
  routes: require('./user.routes'),
  validation: require('./user.validation'),
};
