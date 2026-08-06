const cartService = require('./cart.service');
const CustomError = require('@utils/customError');

// GET /cart
const getCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const cart = await cartService.getCart(userId);

    res.sendResponse({
      message: 'Cart fetched successfully',
      data: cart,
    });
  } catch (error) {
    next(error);
  }
};

// POST /cart
const saveCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { cartItems } = req.body;

    if (!cartItems || !Array.isArray(cartItems)) {
      throw new CustomError(
        400,
        'Invalid cart data. Must be an array of items.'
      );
    }

    await cartService.saveUserCart(userId, cartItems);

    res.sendResponse({
      message: 'Cart saved successfully',
    });
  } catch (error) {
    next(error);
  }
};

// PUT /cart
const updateCartItem = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId, quantity } = req.body;

    if (!productId || quantity == null) {
      throw new CustomError(400, 'Product ID and quantity are required.');
    }

    const updatedItem = await cartService.updateCartItem(
      userId,
      productId,
      quantity
    );

    res.sendResponse({
      message: 'Cart item updated successfully',
      data: updatedItem,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /cart
const removeFromCart = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId } = req.body;

    if (!productId) {
      throw new CustomError(400, 'Product ID is required.');
    }

    await cartService.removeFromCart(userId, productId);

    res.sendResponse({
      message: 'Item removed from cart',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCart,
  saveCart,
  updateCartItem,
  removeFromCart,
};
