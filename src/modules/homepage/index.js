// Barrel file to export all homepage modules

module.exports = {
  controller: require('./homepage.controller'),
  service: require('./homepage.service'),
  model: require('./homepage.model'),
  routes: require('./homepage.routes'),
  validation: require('./homepage.validation'),
};
