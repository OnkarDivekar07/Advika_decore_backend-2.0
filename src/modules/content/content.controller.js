// content controller
const contentService = require('./content.service');

exports.getAllContent = async (req, res, next) => {
  try {
    const content = await contentService.getAllContent();
    res.sendResponse({
      message: 'Site content fetched successfully',
      data: content,
    });
  } catch (error) {
    next(error);
  }
};

exports.upsertContent = async (req, res, next) => {
  try {
    const { key } = req.params;
    const { valueEn, valueHi, valueMr } = req.body;
    const content = await contentService.upsertContent(key, {
      valueEn,
      valueHi,
      valueMr,
    });
    res.sendResponse({
      message: 'Site content updated successfully',
      data: content,
    });
  } catch (error) {
    next(error);
  }
};
