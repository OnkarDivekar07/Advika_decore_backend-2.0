const wishlistService = require('./wishlist.service');

// GET /api/wishlist
exports.getWishlist = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const wishlist = await wishlistService.getWishlist(userId);

    res.sendResponse({
      message: 'Wishlist fetched successfully',
      data: wishlist,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/wishlist
exports.addToWishlist = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId } = req.body;
    const item = await wishlistService.addToWishlist(userId, productId);

    res.sendResponse({
      message: 'Added to wishlist',
      data: item,
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/wishlist/:productId
exports.removeFromWishlist = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { productId } = req.params;
    await wishlistService.removeFromWishlist(userId, productId);

    res.sendResponse({
      message: 'Removed from wishlist',
    });
  } catch (err) {
    next(err);
  }
};
