const prisma = require('@config/prisma');
const paginateWithCache = require('@utils/paginateWithCache');
const CustomError = require('@utils/customError');
const invalidateCacheByPrefix = require('@utils/invalidateCacheByPrefix');
const imageQueue = require('../../jobs/queues/imageQueue');
const { validateMultipleImages } = require('@utils/bannerHelpers');

// Cache prefixes that need invalidating whenever product data changes.
// 'allProducts' backs GET /api/products (this module and the admin
// panel); 'newArrivalProducts' backs GET /api/homepage/new-arrivals,
// which reads from the same Product rows filtered by isNewArrival and
// would otherwise keep serving a stale list for up to its own
// cacheExpiry after an admin flips isNewArrival on/off.
const PRODUCT_CACHE_PREFIXES = ['allProducts', 'newArrivalProducts'];

const invalidateProductCaches = () =>
  Promise.all(
    PRODUCT_CACHE_PREFIXES.map((prefix) => invalidateCacheByPrefix(prefix))
  );

const getAllProducts = (req) => {
  const {
    category,
    minPrice,
    maxPrice,
    inStock,
    isNewArrival,
    isBestSeller,
    voltage,
  } = req.query;

  const where = { isDeleted: false };

  // `category` is a String[] field on Product (prisma/schema.prisma), not
  // a relation with its own id — there is no categoryId/brandId field to
  // filter on (the old filterableFields: ['categoryId', 'brandId'] below
  // could never match anything). The storefront's fetchProducts sends one
  // or more comma-joined category names
  // (frontend-improved/src/services/productsService.js); `hasSome`
  // matches a product carrying ANY of the requested categories.
  if (category) {
    const categories = String(category)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (categories.length > 0) {
      where.category = { hasSome: categories };
    }
  }

  const min = minPrice !== undefined ? parseFloat(minPrice) : NaN;
  const max = maxPrice !== undefined ? parseFloat(maxPrice) : NaN;
  if (!Number.isNaN(min) || !Number.isNaN(max)) {
    where.price = {};
    if (!Number.isNaN(min)) where.price.gte = min;
    if (!Number.isNaN(max)) where.price.lte = max;
  }

  if (inStock === 'true') {
    where.stock = { gt: 0 };
  } else if (inStock === 'false') {
    where.stock = { lte: 0 };
  }

  if (isNewArrival === 'true') {
    where.isNewArrival = true;
  } else if (isNewArrival === 'false') {
    where.isNewArrival = false;
  }

  if (isBestSeller === 'true') {
    where.isBestSeller = true;
  } else if (isBestSeller === 'false') {
    where.isBestSeller = false;
  }

  // Substring match, not equality — a dual-voltage product's voltage
  // field is the literal string "12V/24V", so `contains: "12V"` and
  // `contains: "24V"` both correctly match it. See the README's
  // "Domain rule: 12V vs 24V" — this is the same rule the frontend's
  // category-page voltage chips rely on.
  if (voltage) {
    where.voltage = { contains: voltage };
  }

  return paginateWithCache({
    model: prisma.product,
    req,
    where,
    cachePrefix: 'allProducts',
    cache: true,
    cacheExpiry: 300,
    searchableFields: ['name', 'brand'], // search by product name or brand
    filterableFields: ['brand'], // exact-match filters (brand is a plain string field)
    // category/minPrice/maxPrice/inStock/isNewArrival are folded into
    // `where` above rather than `filterableFields`, so they must be
    // reflected in the cache key explicitly — otherwise two different
    // filtered queries with the same page/limit/sort/search would
    // collide on the same cache entry.
    cacheKeyExtra: {
      category,
      minPrice,
      maxPrice,
      inStock,
      isNewArrival,
      isBestSeller,
      voltage,
    },
  });
};

const getProductById = async (id) => {
  if (!id) {
    throw new CustomError('Product ID is required', 400);
  }

  const product = await prisma.product.findUnique({
    where: { id },
  });

  // Every other public product query in this file (getAllProducts,
  // getProductsByIds, getRelatedProducts) already excludes soft-deleted
  // products — this was the one gap: a delisted/recalled product's detail
  // page kept rendering in full (price, images, "Add to Cart") for anyone
  // with a direct link, even though it was never purchasable (cart.service's
  // assertProductAvailable already 404s it there). Treated identically to
  // a genuinely-missing product — the customer has no reason to be able to
  // tell the two apart.
  if (!product || product.isDeleted) {
    throw new CustomError('Product not found', 404);
  }

  return product;
};

// GET /api/products/batch — bulk lookup by id, public. Only reason this
// exists is so the frontend can revalidate a *guest* cart (localStorage
// only, no backend cart row) against live price/stock/availability without
// one request per line item. Soft-deleted products are silently dropped
// rather than returned with a flag: any id in the request that doesn't
// come back in the response is exactly the "no longer available" signal
// the frontend needs, and it's the same convention cart.service's
// assertProductAvailable already uses (missing/deleted => unavailable).
const getProductsByIds = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  return prisma.product.findMany({
    where: {
      id: { in: ids },
      isDeleted: false,
    },
  });
};

const getRelatedProducts = async (productId) => {
  // Fetch the product and ensure it exists
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { category: true }, // Only fetch what's needed
  });

  if (!product || !product.category || product.category.length === 0) {
    throw new CustomError('Product not found or category missing', 404);
  }

  // Fetch related products based on shared categories (excluding the original product)
  const relatedProducts = await prisma.product.findMany({
    where: {
      isDeleted: false,
      category: {
        hasSome: product.category,
      },
      id: {
        not: productId,
      },
    },
    take: 4,
    orderBy: {
      createdAt: 'desc', // Or use popularity, sales, etc.
    },
  });

  return relatedProducts;
};

const deleteProduct = async (id) => {
  // Check if the product exists
  const product = await prisma.product.findUnique({ where: { id } });

  if (!product) {
    throw new CustomError('Product not found', 404);
  }

  // Mark the product as deleted (soft delete)
  await prisma.product.update({
    where: { id },
    data: { isDeleted: true },
  });

  await invalidateProductCaches();
};

const queueProductCreation = async (productData, images) => {
  validateMultipleImages(images);

  const serializedImages = images.map((img) => ({
    originalname: img.originalname,
    mimetype: img.mimetype,
    buffer: img.buffer.toString('base64'),
  }));

  const job = await imageQueue.add('create-product', {
    serializedImages,
    productInfo: productData,
  });

  return job;
};

const queueProductUpdate = async (productId, updateData, images) => {
  let serializedImages = [];

  if (images && images.length > 0) {
    validateMultipleImages(images);
    serializedImages = images.map((img) => ({
      originalname: img.originalname,
      mimetype: img.mimetype,
      buffer: img.buffer.toString('base64'),
    }));
  }

  return await imageQueue.add('update-product', {
    productId,
    updateData,
    serializedImages,
  });
};

// GET /api/products/jobs/:jobId — lets the admin panel poll the outcome of
// a queueProductCreation/queueProductUpdate job instead of guessing with a
// fixed timeout. Image processing + the S3 upload + the Prisma write all
// happen in imageWorker.js, off the request/response cycle, so this is the
// only truthful way to know whether a given create/update actually landed.
const getProductJobStatus = async (jobId) => {
  if (!jobId) {
    throw new CustomError('Job ID is required', 400);
  }

  const job = await imageQueue.getJob(jobId);
  if (!job) {
    throw new CustomError('Job not found', 404);
  }

  const state = await job.getState();

  const status = { jobId: job.id, state };

  if (state === 'completed') {
    // imageWorker resolves with { id, images } for both create-product and
    // update-product (see imageWorker.js) — surfaced here so the admin UI
    // can confirm which product was affected without a second round trip.
    status.result = job.returnvalue;
  } else if (state === 'failed') {
    status.failedReason = job.failedReason || 'Job failed';
  }

  return status;
};

module.exports = {
  getAllProducts,
  getProductById,
  getProductsByIds,
  getRelatedProducts,
  queueProductCreation,
  deleteProduct,
  queueProductUpdate,
  getProductJobStatus,
  PRODUCT_CACHE_PREFIXES,
};
