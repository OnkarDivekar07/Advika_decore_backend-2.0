// tests/setup/env.js
//
// Several modules read `process.env` at require-time (Razorpay/Twilio SDK
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

// Twilio's SDK validates the SID looks real (starts with "AC") even though
// no request is ever actually made in tests.
process.env.TWILIO_SID = 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'dummy_auth_token';
process.env.TWILIO_PHONE = '+10000000000';

process.env.AWS_ACCESS_KEY_ID = 'dummy_access_key';
process.env.AWS_SECRET_ACCESS_KEY = 'dummy_secret_key';
process.env.BUCKET_NAME = 'dummy-bucket';

process.env.EKART_API_KEY = 'dummy_ekart_api_key';
process.env.EKART_BASE_URL = 'https://api.ekartlogistics.com';
process.env.EKART_MERCHANT_ID = 'dummy_merchant_id';
process.env.EKART_PICKUP_LOCATION_CODE = 'dummy_pickup_location';
process.env.EKART_PICKUP_PINCODE = '400001';
process.env.EKART_WEBHOOK_SECRET = 'dummy_ekart_webhook_secret';
