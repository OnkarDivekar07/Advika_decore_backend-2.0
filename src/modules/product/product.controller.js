const productService = require('./product.service');

exports.createProduct = async (req, res, next) => {
  try {
    const images = req.files;
    let { name, category, brand, price, stock, description, isNewArrival } =
      req.body;

    if (!Array.isArray(category)) {
      if (typeof category === 'string') {
        category = category.split(',').map((c) => c.trim());
      } else {
        category = [];
      }
    }

    const job = await productService.queueProductCreation(
      { name, category, brand, price, stock, description, isNewArrival },
      images
    );

    res.sendResponse({
      message: 'Product upload queued successfully.',
      data: { jobId: job.id },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateProduct = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const images = req.files;
    const updateData = req.body;

    const job = await productService.queueProductUpdate(
      productId,
      updateData,
      images
    );

    res.sendResponse({
      message: 'Product update queued successfully.',
      data: { jobId: job.id },
    });
  } catch (error) {
    next(error);
  }
};

exports.getAllProducts = async (req, res, next) => {
  try {
    const result = await productService.getAllProducts(req);
    res.sendResponse({
      message: 'Products fetched successfully',
      data: result.data,
      meta: result.meta,
    });
  } catch (err) {
    next(err);
  }
};

exports.getProductById = async (req, res, next) => {
  try {
    const result = await productService.getProductById(req.params.id);
    res.sendResponse({
      message: 'Product fetched successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/products/batch?ids=a,b,c — see product.validation's
// validateGetProductsByIds for the sanitizing/capping of req.query.ids into
// a deduped array; this just forwards it.
exports.getProductsByIds = async (req, res, next) => {
  try {
    const result = await productService.getProductsByIds(req.query.ids);
    res.sendResponse({
      message: 'Products fetched successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

exports.getRelatedProducts = async (req, res, next) => {
  try {
    const result = await productService.getRelatedProducts(req.params.id);

    res.sendResponse({
      message: 'Related products fetched successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteProduct = async (req, res, next) => {
  try {
    await productService.deleteProduct(req.params.id);

    res.sendResponse({
      message: 'Product deleted successfully',
      data: null,
    });
  } catch (error) {
    next(error);
  }
};
