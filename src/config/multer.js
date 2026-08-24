// src/utils/multerConfig.js
const multer = require('multer');
const CustomError = require('@utils/customError');

// Every image this app accepts ends up either compressed to WebP before S3
// (product images — see src/jobs/workers/imageWorker.js) or uploaded as-is
// (banner images — see homepage.controller.js), so anything other than a
// real raster image format has no legitimate use here. Without this,
// multer would accept literally any file under an "image"/"images" field —
// a script, an executable, an arbitrarily large blob — and hand it
// straight to sharp/S3.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// 5MB per file — generous for a product photo/banner straight off a phone
// camera, small enough that a handful of concurrent uploads can't turn
// into a memory-exhaustion vector: multer.memoryStorage() below holds each
// file entirely in process memory (not on disk) until it's handed off to
// sharp/S3.
const MAX_UPLOAD_SIZE_MB = 5;

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(
      new CustomError(
        `Unsupported file type "${file.mimetype}". Only JPEG, PNG, and WebP images are allowed.`,
        400
      )
    );
  }
  cb(null, true);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    files: 5, // matches product.routes.js's own upload.array('images', 5) ceiling
  },
  fileFilter,
});

// multer calls next(err) directly on a size/count/fileFilter violation
// rather than throwing synchronously into the route handler, so a plain
// try/catch in the controller never sees it. This has to sit in the
// route's own middleware chain (Express recognizes the 4-arg signature as
// error-handling) right after upload.single/array — not in the global
// errorHandler — so MulterError's own `.code` is still available here to
// explain *which* limit was hit before it's normalized into the same
// CustomError shape every other 400 in this app uses.
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB}MB per image.`
        : err.code === 'LIMIT_FILE_COUNT' ||
            err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Too many files uploaded.'
          : err.message;
    return next(new CustomError(message, 400));
  }
  next(err);
};

module.exports = upload; // ⬅️ ✅ Direct export
module.exports.handleUploadError = handleUploadError;
