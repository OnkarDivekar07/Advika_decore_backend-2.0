// src/controllers/banner/bannerController.js
const homepageService = require('./homepage.service');
const awsService = require('../../services/external/AWSUploads');
const CustomError = require('@utils/customError');
const {
  generateUniqueBannerFilename,
  validateImage,
} = require('@utils/bannerHelpers');

// GET /api/banner
const getBanners = async (req, res, next) => {
  try {
    const result = await homepageService.getLatestBanner(req);

    res.sendResponse({
      message: 'Banners fetched successfully',
      data: result.data,
      meta: result.meta,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/banner  (image upload + DB save)
const createBanner = async (req, res, next) => {
  try {
    const { linkUrl } = req.body;
    const image = req.file;

    validateImage(image);

    const filename = generateUniqueBannerFilename(image.originalname);
    const imageUrl = await awsService.uploadToS3(
      image.buffer,
      filename,
      image.mimetype
    );

    const banner = await homepageService.createNewBanner(imageUrl, linkUrl);

    res.sendResponse({
      message: 'Banner created successfully',
      data: banner,
      statusCode: 201,
    });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/banner/:id
const deleteBanner = async (req, res, next) => {
  try {
    const { id } = req.params;
    const banner = await homepageService.getBannerById(id);

    if (!banner) {
      throw new CustomError('Banner not found', 404);
    }

    const key = banner.imageUrl.split('.com/')[1];
    await awsService.deleteFromS3(key);
    await homepageService.deleteBannerById(id);

    res.sendResponse({
      message: 'Banner deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/banner/new-arrivals
const getNewArrivalProducts = async (req, res, next) => {
  try {
    const result = await homepageService.getNewArrivalProducts(req);
    res.sendResponse({
      message: 'New arrivals fetched successfully',
      data: result.data,
      meta: result.meta,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/banner/new-arrivals/:id
const softDeleteNewArrival = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updatedProduct =
      await homepageService.softDeleteNewArrivalService(id);

    res.sendResponse({
      message: 'Product removed from new arrivals',
      data: updatedProduct,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getBanners,
  createBanner,
  deleteBanner,
  getNewArrivalProducts,
  softDeleteNewArrival,
};
