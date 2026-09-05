// tests/e2e-helpers/cleanupE2EUploads.js
//
// Deletes the real Cloudflare R2 objects an admin real-E2E
// product-creation test uploaded to the real `advika-auto-media` bucket,
// WITHOUT any application code change. This is possible because of how
// the app already names uploaded files
// (src/utils/bannerHelpers.js's generateUniqueProductFilenames):
//
//   product-images/{timestamp}_{index}_{basename-of-uploaded-filename}.webp
//
// The E2E test fixture image is named "e2e-fixture-<runId>.jpg" (see
// admin_panel_fixed/e2e-real/fixtures/e2e-fixture.jpg + how the spec copies
// it to a run-unique filename before uploading), so every object key this
// script ever deletes is guaranteed to contain "e2e-fixture-" in its
// basename — it can never match a real product image, whose original
// filename an admin chose themselves.
//
// Usage (see admin_panel_fixed/package.json's e2e:real:admin:cleanup):
//   node "../backend 2.0/tests/e2e-helpers/cleanupE2EUploads.js" <bucketName> <key1> [<key2> ...]
// Keys are collected by the Playwright spec itself (from the real
// product-create API response's `images` URLs) into a JSON file, which the
// spec's own afterAll reads and passes here — see
// admin_panel_fixed/e2e-real/support/s3KeyLog.js.
//
// Migrated from AWS S3 to R2 alongside src/services/external/AWSUploads.js
// — same S3-compatible client, just pointed at R2's endpoint/credentials.
const {
  S3Client,
  DeleteObjectsCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

function buildClient() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

// Pattern 14: direct proof (not an inference from an HTTP 200) that a given
// R2 object does or doesn't exist — used to verify deleteSupersededImages
// (imageWorker.js) actually removed the old object from the real bucket,
// and not just that the app "said" it did.
async function objectExistsInR2(bucketName, key) {
  const client = buildClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

async function deleteE2EUploads(bucketName, keys) {
  const safeKeys = keys.filter(
    (key) => typeof key === 'string' && key.includes('e2e-fixture-')
  );
  if (safeKeys.length === 0) return { deleted: 0, skipped: keys.length };

  const client = buildClient();

  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: safeKeys.map((Key) => ({ Key })), Quiet: true },
    })
  );

  return { deleted: safeKeys.length, skipped: keys.length - safeKeys.length };
}

module.exports = { deleteE2EUploads, objectExistsInR2 };

if (require.main === module) {
  require('dotenv').config({ path: `${__dirname}/../../.env.e2e` });
  const [bucketName, ...keys] = process.argv.slice(2);
  if (!bucketName || keys.length === 0) {
    console.log('Usage: node cleanupE2EUploads.js <bucketName> <key1> [<key2> ...]');
    process.exit(0);
  }
  deleteE2EUploads(bucketName, keys).then((result) => {
    console.log(
      `[cleanupE2EUploads] deleted ${result.deleted} E2E-tagged object(s), skipped ${result.skipped} non-E2E-tagged key(s).`
    );
  });
}
