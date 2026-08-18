const productService = require('./product.service');
const { matchedData } = require('express-validator');

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
// validateGetProductsByIds for the sanitizing/capping of ids into a
// deduped array.
//
// Reads the sanitized value via matchedData() rather than req.query.ids.
// Express 5 makes req.query a getter computed fresh from the URL on every
// access, with no setter — so express-validator's customSanitizer/toInt/
// toFloat/toBoolean calls run and are reflected in validationResult(),
// but silently fail to write back onto req.query itself. Reading
// req.query.ids here would still see the raw, undeduped, uncapped string
// exactly as the client sent it. matchedData() returns the value
// express-validator actually computed, independent of that mutation.
exports.getProductsByIds = async (req, res, next) => {
  try {
    const { ids } = matchedData(req);
    const result = await productService.getProductsByIds(ids);
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

exports.getProductJobStatus = async (req, res, next) => {
  try {
    const result = await productService.getProductJobStatus(req.params.jobId);
    res.sendResponse({
      message: 'Job status fetched successfully',
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
