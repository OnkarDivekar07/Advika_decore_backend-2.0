const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const logger = require('@config/logger');
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const bucketName = process.env.BUCKET_NAME;

const s3Client = new S3Client({
  region: 'ap-south-1',
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  },
  forcePathStyle: true,
});

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
      ACL: 'public-read',
      ContentType: contentType,
    };
    const data = await s3Client.send(new PutObjectCommand(uploadParams));
    const publicUrl = `https://${uploadParams.Bucket}.s3.ap-south-1.amazonaws.com/${uploadParams.Key}`;
    return publicUrl;
  } catch (error) {
    logger.error(`Error uploading file to S3: ${error.message}`);
    throw error;
  }
};

exports.deleteFromS3 = async (key) => {
  try {
    const deleteParams = {
      Bucket: bucketName,
      Key: key,
    };
    await s3Client.send(new DeleteObjectCommand(deleteParams));
  } catch (error) {
    logger.error(`Error deleting from S3: ${error.message}`);
    throw error;
  }
};
