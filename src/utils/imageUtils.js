// utils/imageUtils.js
const sharp = require('sharp');

const compressImageBuffer = async (buffer, format = 'webp', quality = 80) => {
  return sharp(buffer)
    .resize({ width: 1000 }) // optional: resize to limit dimensions
    .toFormat(format, { quality })
    .toBuffer();
};

module.exports = { compressImageBuffer };
