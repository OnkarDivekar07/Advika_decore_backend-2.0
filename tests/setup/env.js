// tests/setup/env.js
//
// Several modules read `process.env` at require-time (Razorpay SDK
// clients, config/env.js's required-var check, etc). This file runs before
// any test file is loaded (see jest.config.js -> setupFiles) so those reads
// always see a value — none of these are real credentials, tests mock every
// network-facing call.

process.env.NODE_ENV = 'test';
process.env.PORT = '5000';
process.env.DATABASE_URL = 'mongodb://localhost:27017/backend_2_0_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CORS_ORIGINS = 'http://localhost:3000';

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'dummy_webhook_secret';

// MSG91 values used by the OTP service tests.
process.env.MSG91_AUTH_KEY = 'test_msg91_auth_key';
process.env.MSG91_TEMPLATE_ID = 'test_msg91_template_id';

// Legacy S3 — no longer read by AWSUploads.js, kept only in case other
// tooling still expects these to be set.
process.env.AWS_ACCESS_KEY_ID = 'dummy_access_key';
process.env.AWS_SECRET_ACCESS_KEY = 'dummy_secret_key';
process.env.BUCKET_NAME = 'dummy-bucket';

// Cloudflare R2 — see src/services/external/AWSUploads.js.
process.env.R2_ACCOUNT_ID = 'dummy_r2_account_id';
process.env.R2_ACCESS_KEY_ID = 'dummy_r2_access_key';
process.env.R2_SECRET_ACCESS_KEY = 'dummy_r2_secret_key';
process.env.R2_BUCKET_NAME = 'dummy-r2-bucket';
process.env.R2_ENDPOINT = 'https://dummy-account.r2.cloudflarestorage.com';
process.env.R2_PUBLIC_URL = 'https://media.test.example';

process.env.DELHIVERY_API_TOKEN = 'dummy_delhivery_api_token';
process.env.DELHIVERY_BASE_URL = 'https://track.delhivery.com';
process.env.DELHIVERY_PICKUP_LOCATION_NAME = 'dummy_pickup_location';
process.env.DELHIVERY_SELLER_NAME = 'dummy_seller_name';
process.env.DELHIVERY_PICKUP_PINCODE = '400001';
process.env.DELHIVERY_WEBHOOK_SECRET = 'dummy_delhivery_webhook_secret';
