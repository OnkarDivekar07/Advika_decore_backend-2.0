const prisma = require('@config/prisma');
const paginateWithCache = require('@utils/paginateWithCache');
const CustomError = require('@utils/customError');
const imageQueue = require('../../jobs/queues/imageQueue');
const { validateMultipleImages } = require('@utils/bannerHelpers');

const getAllProducts = (req) => {
  return paginateWithCache({
    model: prisma.product,
    req,
    where: { isDeleted: false },
    cachePrefix: 'allProducts',
    cache: true,
    cacheExpiry: 300,
    searchableFields: ['name'], // search by product name
    filterableFields: ['categoryId', 'brandId'], // optional filters
  });
};

const getProductById = async (id) => {
  if (!id) {
    throw new CustomError('Product ID is required', 400);
  }

  const product = await prisma.product.findUnique({
    where: { id },
  });

  if (!product) {
    throw new CustomError('Product not found', 404);
  }

  return product;
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

module.exports = {
  getAllProducts,
  getProductById,
  getRelatedProducts,
  queueProductCreation,
  deleteProduct,
  queueProductUpdate,
};
