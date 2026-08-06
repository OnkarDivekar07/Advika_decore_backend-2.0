const prisma = require('@config/prisma');
const paginateWithCache = require('@utils/paginateWithCache');

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
  return await prisma.banner.create({
    data: { imageUrl, linkUrl },
  });
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
  return updatedProduct;
};

const getBannerById = async (id) => {
  return await prisma.banner.findUnique({
    where: { id },
  });
};

const deleteBannerById = async (id) => {
  return await prisma.banner.delete({
    where: { id },
  });
};

module.exports = {
  getLatestBanner,
  createNewBanner,
  deleteBannerById,
  getBannerById,
  softDeleteNewArrivalService,
  getNewArrivalProducts,
};
