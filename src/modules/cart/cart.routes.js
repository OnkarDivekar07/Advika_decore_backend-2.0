const express = require('express');
const router = express.Router();

const { saveCart, getCart } = require('./cart.controller');

const authenticate = require('@middlewares/authenticate');
const { validateSaveCart } = require('./cart.validation');
const validateRequest = require('@middlewares/validateRequest');

// Protect all cart routes
router.use(authenticate);

router.post('/', validateSaveCart, validateRequest, saveCart);

router.get('/', getCart);

module.exports = router;
