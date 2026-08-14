// Barrel file to export all wishlist modules

module.exports = {
  controller: require('./wishlist.controller'),
  service: require('./wishlist.service'),
  model: require('./wishlist.model'),
  routes: require('./wishlist.routes'),
  validation: require('./wishlist.validation'),
};
