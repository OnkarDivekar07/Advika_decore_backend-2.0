const express = require('express');
const router = express.Router();

// Route path constants
const ROUTES = {
  cart: require('@modules/cart').routes,
  admin: require('@modules/admin').routes,
  user: require('@modules/user').routes,
  product: require('@modules/product').routes,
  order: require('@modules/order').routes,
  payment: require('@modules/payment').routes,
  homepage: require('@modules/homepage').routes,
  otp: require('@modules/otp').routes,
  inventory: require('@modules/inventory').routes,
  shipping: require('@modules/shipping').routes,
  wishlist: require('@modules/wishlist').routes,
};

// Mount active routes
router.use('/cart', ROUTES.cart);
router.use('/admin', ROUTES.admin);
router.use('/otp', ROUTES.otp);
router.use('/user', ROUTES.user);
router.use('/products', ROUTES.product);
router.use('/order', ROUTES.order);
router.use('/payment', ROUTES.payment);
router.use('/homepage', ROUTES.homepage);
router.use('/inventory', ROUTES.inventory);
router.use('/shipping', ROUTES.shipping);
router.use('/wishlist', ROUTES.wishlist);

// Fallback route (404)
router.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

module.exports = router;
