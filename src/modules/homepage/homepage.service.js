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
  // Same staleness bug as createNewBanner/deleteBannerById below, for the
  // 'newArrivalProducts' cachePrefix this flip actually affects.
  await invalidateCacheByPrefix('newArrivalProducts');
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
