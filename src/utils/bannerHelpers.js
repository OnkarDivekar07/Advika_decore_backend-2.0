const CustomError = require('./customError');
const path = require('path');
const sharp = require('sharp');

// Real formats sharp can decode that this app is willing to serve —
// deliberately the same set @config/multer.js's fileFilter claims to
// allow (jpeg/png/webp). multer's check only looks at the client-supplied
// `Content-Type` part of the multipart body, which costs an attacker
// nothing to spoof (send real HTML/SVG/script content with
// `Content-Type: image/jpeg`) — unlike product images, banner uploads are
// never re-encoded through sharp (see homepage.controller.js's own
// comment), so nothing downstream of multer used to actually look at the
// real bytes before this file got stored on the public media CDN with
// whatever Content-Type the client claimed.
const REAL_FORMAT_TO_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// Decodes just enough of the buffer to read its real format (sharp reads
// image headers, not the full pixel data, for `.metadata()` — cheap) and
// throws if it isn't a genuinely decodable image in an allowed format.
// Returns the ground-truth MIME type to actually store the object with,
// which the caller must use instead of the client-supplied
// `image.mimetype` — that value is attacker-controlled and must never be
// trusted as the stored Content-Type.
async function validateImage(image) {
  if (!image) {
    throw new CustomError('No image file uploaded', 400);
  }

  let format;
  try {
    ({ format } = await sharp(image.buffer).metadata());
  } catch {
    throw new CustomError(
      'File is not a valid image (unable to read image data).',
      400
    );
  }

  const realMimeType = REAL_FORMAT_TO_MIME[format];
  if (!realMimeType) {
    throw new CustomError(
      `Unsupported image format "${format || 'unknown'}". Only JPEG, PNG, and WebP images are allowed.`,
      400
    );
  }

  return realMimeType;
}

function validateMultipleImages(images) {
  if (!images || !Array.isArray(images) || images.length === 0) {
    throw new CustomError('No images uploaded', 400);
  }
}

const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// `originalName` is the client-supplied multipart filename — attacker
// input, not sanitized by multer itself. Previously interpolated
// straight into the R2 object key: a crafted originalname (e.g.
// containing `/`) could land the object under an unrelated key prefix
// like `product-images/...`, and its own claimed extension (however
// unrelated to the file's real bytes) went straight onto the public URL.
// The basename is now reduced to a safe character set and the extension
// is always derived from `realMimeType` — the sharp-verified actual
// format from validateImage, never the attacker-supplied name or
// multer's client-reported mimetype.
function generateUniqueBannerFilename(originalName, realMimeType) {
  const baseName =
    path
      .parse(String(originalName || 'banner'))
      .name.replace(/[^A-Za-z0-9_-]+/g, '_')
      .slice(0, 100) || 'banner';
  const extension = MIME_TO_EXTENSION[realMimeType] || 'jpg';
  return `banner-images/${Date.now()}_${baseName}.${extension}`;
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
