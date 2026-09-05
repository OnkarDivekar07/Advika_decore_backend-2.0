// src/controllers/banner/bannerController.js
const homepageService = require('./homepage.service');
const awsService = require('../../services/external/AWSUploads');
const CustomError = require('@utils/customError');
const logger = require('@config/logger');
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

    // keyFromPublicUrl returns null when imageUrl matches neither the R2
    // nor the legacy S3 pattern (e.g. R2_PUBLIC_URL was changed after this
    // banner was saved, or the row was imported). deleteFromS3(null)
    // throws a client-side "No value provided for input HTTP label: Key"
    // error (confirmed against the real R2 SDK) — every attempt to remove
    // that banner would fail before ever reaching deleteBannerById below,
    // permanently stuck. Skip the storage delete rather than block the
    // admin's explicit request to remove the DB row over an object we
    // can't identify anyway.
    const key = awsService.keyFromPublicUrl(banner.imageUrl);
    if (key) {
      await awsService.deleteFromS3(key);
    } else {
      logger.warn(
        `Could not resolve an R2/S3 key from banner ${id}'s imageUrl (${banner.imageUrl}) — skipping storage delete.`
      );
    }
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
