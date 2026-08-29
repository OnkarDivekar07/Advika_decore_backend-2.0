// Barrel file to export all content modules
module.exports = {
  controller: require('./content.controller'),
  service: require('./content.service'),
  routes: require('./content.routes'),
  validation: require('./content.validation'),
};
