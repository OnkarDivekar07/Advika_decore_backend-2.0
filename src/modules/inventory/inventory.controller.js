// inventory controller
const inventoryService = require('./inventory.service');

exports.getStock = async (req, res, next) => {
  try {
    const result = await inventoryService.getStockForProduct(req.params.productId);

    res.sendResponse({
      message: 'Stock fetched successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getLowStockProducts = async (req, res, next) => {
  try {
    const threshold = req.query.threshold ?? 10;
    const result = await inventoryService.listLowStockProducts(threshold);

    res.sendResponse({
      message: 'Low stock products fetched successfully',
      data: result,
      meta: { threshold },
    });
  } catch (error) {
    next(error);
  }
};

exports.adjustStock = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { action, quantity, expectedStock } = req.body;

    // Only forwarded when the caller actually sent it, so the service's
    // default (blind write, previous behavior) is unchanged for any
    // existing caller that doesn't know about this optional field.
    const product =
      expectedStock === undefined
        ? await inventoryService.adjustStock(productId, action, quantity)
        : await inventoryService.adjustStock(productId, action, quantity, expectedStock);

    res.sendResponse({
      message: 'Stock updated successfully',
      data: product,
    });
  } catch (error) {
    next(error);
  }
};
