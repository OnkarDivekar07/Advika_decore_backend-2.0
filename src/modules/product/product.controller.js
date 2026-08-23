const productService = require('./product.service');
const { matchedData } = require('express-validator');

// Fields the client may send as a JSON-encoded string (multipart/form-data
// has no native object/array type) — parsed back into real JSON before
// being written to the Json? columns on Product. Left as-is (and validated
// as already-parsed) when the client is JSON-mode instead of multipart.
const JSON_PRODUCT_FIELDS = ['specs', 'variants', 'compatibility'];

const parseJsonFields = (body) => {
  const parsed = {};
  for (const field of JSON_PRODUCT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] === 'string') {
      try {
        parsed[field] = JSON.parse(body[field]);
      } catch {
        // Left to validateCreateProduct/validateUpdateProduct's isJSON
        // check to reject — surfacing here as undefined would silently
        // drop a malformed payload instead of erroring it.
        parsed[field] = body[field];
      }
    } else {
      parsed[field] = body[field];
    }
  }
  return parsed;
};

exports.createProduct = async (req, res, next) => {
  try {
    const images = req.files;
    let {
      name,
      category,
      brand,
      price,
      stock,
      description,
      isNewArrival,
      // --- Advika Auto storefront fields (see prisma/schema.prisma and
      // design_handoff_advika_auto/README.md "Domain rule: 12V vs 24V") ---
      mrp,
      voltage,
      isBestSeller,
      rating,
      reviewCount,
    } = req.body;

    if (!Array.isArray(category)) {
      if (typeof category === 'string') {
        category = category.split(',').map((c) => c.trim());
      } else {
        category = [];
      }
    }

    const job = await productService.queueProductCreation(
      {
        name,
        category,
        brand,
        price,
        stock,
        description,
        isNewArrival,
        mrp,
        voltage,
        isBestSeller,
        rating,
        reviewCount,
        ...parseJsonFields(req.body),
      },
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
    const updateData = { ...req.body, ...parseJsonFields(req.body) };

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
