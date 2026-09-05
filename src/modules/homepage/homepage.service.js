const prisma = require('@config/prisma');
const paginateWithCache = require('@utils/paginateWithCache');
const invalidateCacheByPrefix = require('@utils/invalidateCacheByPrefix');

const getLatestBanner = (req) => {
  return paginateWithCache({
    model: prisma.banner,
    req,
    where: {},
    cachePrefix: 'banners',
    cache: true,
    cacheExpiry: 300,
  });
};

// Create new banner
const createNewBanner = async (imageUrl, linkUrl) => {
  const banner = await prisma.banner.create({
    data: { imageUrl, linkUrl },
  });
  // Without this, GET /api/homepage/banners (cachePrefix 'banners', see
  // getLatestBanner) keeps serving the pre-create list for up to its own
  // 300s cacheExpiry — same staleness bug product.service.js already
  // guards against on every product mutation.
  await invalidateCacheByPrefix('banners');
  return banner;
};

// homepage.service.js

const getNewArrivalProducts = (req) => {
  return paginateWithCache({
    model: prisma.product,
    req,
    where: { isNewArrival: true, isDeleted: false },
    cachePrefix: 'newArrivalProducts',
    cache: true,
    cacheExpiry: 300,
  });
};

const softDeleteNewArrivalService = async (id) => {
  const updatedProduct = await prisma.product.update({
    where: { id },
    data: { isNewArrival: false },
  });
  // Same staleness bug as createNewBanner/deleteBannerById below. Busts
  // BOTH prefixes this flip actually affects — 'newArrivalProducts'
  // (GET /api/homepage/new-arrivals) and 'allProducts', since
  // product.service.js's getAllProducts also caches listings filtered by
  // isNewArrival (GET /api/products?isNewArrival=true) under that same
  // prefix — leaving that one out meant a cached filtered listing page
  // could keep showing a product for up to its own TTL after this flip
  // turned it off.
  await Promise.all([
    invalidateCacheByPrefix('newArrivalProducts'),
    invalidateCacheByPrefix('allProducts'),
  ]);
  return updatedProduct;
};

const getBannerById = async (id) => {
  return await prisma.banner.findUnique({
    where: { id },
  });
};

const deleteBannerById = async (id) => {
  const banner = await prisma.banner.delete({
    where: { id },
  });
  await invalidateCacheByPrefix('banners');
  return banner;
};

module.exports = {
  getLatestBanner,
  createNewBanner,
  deleteBannerById,
  getBannerById,
  softDeleteNewArrivalService,
  getNewArrivalProducts,
};
