// Media storage backend — migrated from AWS S3 to Cloudflare R2. Kept in
// this file (same name, same `uploadToS3`/`deleteFromS3` exports used by
// imageWorker.js and homepage.controller.js) so no call site anywhere in
// the app had to change. R2 is S3-compatible, so this still uses
// @aws-sdk/client-s3 — only the client's endpoint/credentials and the
// public-URL format changed.
//
// The old `advikaauto` S3 bucket is deliberately left untouched: every
// image URL already stored in the database (existing products/banners)
// still points at `*.s3.ap-south-1.amazonaws.com` and keeps resolving
// exactly as before. Only *new* uploads go to R2 from here on — this is a
// forward-only cutover, not a data migration, so nothing already in S3
// needs to move for the app to keep working.
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const logger = require('@config/logger');

const bucketName = process.env.R2_BUCKET_NAME;
const publicUrlBase = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

const getR2Client = (() => {
  let client;
  return () => {
    if (client) return client;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const endpoint = process.env.R2_ENDPOINT;
    if (!accountId || !accessKeyId || !secretAccessKey || !endpoint || !bucketName || !publicUrlBase) {
      throw new Error(
        'Cloudflare R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET_NAME and R2_PUBLIC_URL.'
      );
    }
    client = new S3Client({
      // R2 ignores the region value (it's not a region-partitioned
      // service) but the SDK requires one to be set — 'auto' is
      // Cloudflare's own documented convention for this field.
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // Required for R2: the account-scoped endpoint expects
      // https://<endpoint>/<bucket>/<key>, not virtual-hosted-style.
      forcePathStyle: true,
    });
    return client;
  };
})();

// `contentType` defaults to what every product image actually is by the
// time it gets here — src/jobs/workers/imageWorker.js always runs the
// upload buffer through compressImageBuffer(), which re-encodes to WebP
// regardless of what the original upload was. Banner uploads aren't
// recompressed (see homepage.controller.js), so that call site passes the
// real `image.mimetype` from multer instead of relying on this default.
// Previously this was hardcoded to 'image/jpeg' unconditionally, so every
// banner (and, ironically, every WebP product image) was served with a
// Content-Type that didn't match its actual bytes.
exports.uploadToS3 = async (image, filename, contentType = 'image/webp') => {
  try {
    const uploadParams = {
      Bucket: bucketName,
      Key: filename,
      Body: image,
      // No ACL here: unlike S3, R2 doesn't use per-object ACLs for public
      // access — the bucket's custom domain (R2_PUBLIC_URL) is what makes
      // objects publicly readable, configured once in the Cloudflare
      // dashboard, not per-upload.
      ContentType: contentType,
    };
    await getR2Client().send(new PutObjectCommand(uploadParams));
    return `${publicUrlBase}/${uploadParams.Key}`;
  } catch (error) {
    logger.error(`Error uploading file to R2: ${error.message}`);
    throw error;
  }
};

// Recovers the storage key from a URL this module produced (or from a
// legacy S3 URL), for callers that only kept the public URL — e.g.
// homepage.controller.js's deleteBanner, which used to do
// `banner.imageUrl.split('.com/')[1]`. That assumed the host before the
// key always contained ".com/", which broke the moment R2_PUBLIC_URL
// became a non-.com domain (e.g. "https://media.advikaauto.in"). This
// strips the real configured R2_PUBLIC_URL prefix first, falling back to
// the old S3 marker so banners uploaded before the R2 migration (still
// pointing at *.amazonaws.com) keep deleting correctly too.
exports.keyFromPublicUrl = (url) => {
  if (typeof url !== 'string') return null;
  if (publicUrlBase && url.startsWith(`${publicUrlBase}/`)) {
    return url.slice(publicUrlBase.length + 1);
  }
  const s3Marker = '.amazonaws.com/';
  const idx = url.indexOf(s3Marker);
  return idx === -1 ? null : url.slice(idx + s3Marker.length);
};

exports.deleteFromS3 = async (key) => {
  try {
    const deleteParams = {
      Bucket: bucketName,
      Key: key,
    };
    await getR2Client().send(new DeleteObjectCommand(deleteParams));
  } catch (error) {
    logger.error(`Error deleting from R2: ${error.message}`);
    throw error;
  }
};
