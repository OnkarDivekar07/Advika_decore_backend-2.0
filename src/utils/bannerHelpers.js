const CustomError = require('./customError');
const path = require('path');

function validateImage(image) {
  if (!image) {
    throw new CustomError('No image file uploaded', 400);
  }
}

function validateMultipleImages(images) {
  if (!images || !Array.isArray(images) || images.length === 0) {
    throw new CustomError('No images uploaded', 400);
  }
}

function generateUniqueBannerFilename(originalName) {
  return `banner-images/${Date.now()}_${originalName}`;
}

function generateUniqueProductFilenames(originalNames = []) {
  const timestamp = Date.now();
  return originalNames.map((name, index) => {
    const baseName = path.parse(name).name.replace(/\s+/g, '_');
    return `product-images/${timestamp}_${index}_${baseName}.webp`;
  });
}

module.exports = {
  validateImage,
  generateUniqueBannerFilename,
  validateMultipleImages,
  generateUniqueProductFilenames,
};
