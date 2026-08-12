# Advika E-Commerce — Backend (backend 2.0)

REST API server powering the Advika e-commerce platform. Built with **Node.js, Express 5, Prisma (MongoDB), Redis/BullMQ, MSG91, Razorpay and AWS S3**.

---

## 1. Tech Stack

| Layer            | Technology                                   |
|------------------|-----------------------------------------------|
| Runtime          | Node.js (CommonJS)                            |
| Framework        | Express 5                                     |
| Database         | MongoDB (via Prisma ORM)                      |
| Caching / Queues | Redis (ioredis) + BullMQ (background jobs)    |
| Auth             | JWT (jsonwebtoken), bcrypt password hashing    |
| File storage     | AWS S3 (`@aws-sdk/client-s3`)                 |
| Image processing | sharp                                          |
| SMS / OTP        | MSG91                                        |
| Payments         | Razorpay                                       |
| API docs         | Swagger (swagger-jsdoc + swagger-ui-express)  |
| Validation       | express-validator                              |
| Security         | Helmet, CORS, custom rate limiter              |
| Logging          | Morgan                                         |

---

## 2. Project Structure

```
backend 2.0/
├── server.js                # Entry point — boots the HTTP server
├── src/
│   ├── app.js                # Express app setup (middleware, routes, swagger)
│   ├── config/               # env, prisma, redis, multer, swagger, server config
│   ├── middlewares/          # authenticate, authorizeAdminOnly, errorHandler,
│   │                          # rateLimiter, responseMiddleware, validateRequest
│   ├── modules/               # Feature modules (each self-contained)
│   │   ├── admin/            # Admin login, dashboard stats, user list
│   │   ├── cart/              # Cart save/fetch
│   │   ├── homepage/          # Banners + new arrivals
│   │   ├── inventory/         # Inventory management (stub)
│   │   ├── order/             # Draft orders, order history, admin order views
│   │   ├── otp/                # Send/verify OTP login
│   │   ├── payment/           # Razorpay order creation, verification, COD
│   │   ├── product/           # Product CRUD, related products
│   │   └── user/              # Addresses, user profile
│   ├── routes/apiRoutes.js    # Mounts all module routes under /api
│   ├── jobs/                  # BullMQ queues + workers (cart clearing, image processing)
│   ├── services/external/    # AWS S3 upload/delete helper
│   └── utils/                  # Token, password, error, pagination, response helpers
├── prisma/
│   ├── schema.prisma          # Data models (User, Product, Order, Cart, Review, etc.)
│   └── seed.js                 # Seed script
├── scripts/gen-feature.js     # CLI generator to scaffold a new module
└── tests/load-test.js          # Basic load test script
```

Each module (`src/modules/<name>`) follows the same pattern: `*.routes.js → *.controller.js → *.service.js`, with `*.validation.js` for request validation and `*.docs.js`/`*.doc.js` for Swagger documentation.

---

## 3. Prerequisites

- Node.js 18+
- A MongoDB database (Atlas or self-hosted) — Prisma is configured for the `mongodb` provider
- A running Redis instance (used by BullMQ job queues)
- MSG91 account (for OTP SMS)
- Razorpay account (for payments)
- AWS S3 bucket + IAM credentials (for product/banner image uploads)

---

## 4. Environment Variables

Create a `.env` file in `backend 2.0/` with the following keys:

```env
# Server
PORT=5000

# Database (MongoDB connection string used by Prisma)
DATABASE_URL="mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority"

# Auth
JWT_SECRET=your_jwt_secret_key

# Redis (used by BullMQ queues and otp/redisClient)
REDIS_URL=redis://127.0.0.1:6379

# MSG91 (OTP SMS)
MSG91_AUTH_KEY=your_msg91_auth_key
MSG91_TEMPLATE_ID=your_msg91_otp_template_id

# Razorpay
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret

# AWS S3 (image uploads)
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
BUCKET_NAME=your_s3_bucket_name

# Delivery pricing (optional — see src/constants/pricing.js / src/config/env.js)
FREE_DELIVERY_THRESHOLD=600
DELIVERY_CHARGE=49

# Ekart Logistics (shipping/serviceability — see src/services/external/EkartClient.js)
EKART_BASE_URL=https://api.ekartlogistics.com
EKART_API_KEY=your_ekart_api_key
EKART_MERCHANT_ID=your_ekart_merchant_id
EKART_WEBHOOK_SECRET=your_ekart_webhook_secret
EKART_PICKUP_LOCATION_CODE=your_ekart_pickup_location_code
EKART_PICKUP_PINCODE=your_warehouse_pincode
EKART_REQUEST_TIMEOUT_MS=8000

# What to do when the Ekart serviceability check itself fails to answer at
# all (timeout/network/5xx) right before an order is placed — see
# shipping.service.js's checkDeliveryEligibility. 'fail_open' (default)
# never blocks checkout on a carrier hiccup; 'fail_closed' blocks it rather
# than guessing. Optional — defaults to 'fail_open' if unset.
SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_open
```

> `PORT` and `DATABASE_URL` are strictly required — the app throws an error on boot if either is missing (see `src/config/env.js`). All other variables are required only for the features that use them (OTP, payments, image upload).

---

## 5. Installation & Running Locally

```bash
cd "backend 2.0"

# 1. Install dependencies
npm install

# 2. Generate Prisma client
npx prisma generate

# 3. (Optional) push schema to your MongoDB / seed sample data
npx prisma db push
npm run seed

# 4. Start the server (nodemon, auto-restarts on file changes)
npm start
```

The API will be available at `http://localhost:5000/api`, and Swagger docs at `http://localhost:5000/api-docs`.

Make sure Redis is running locally (or point `REDIS_URL` to a remote instance) before starting the server, since job workers connect to it on boot.

---

## 6. NPM Scripts

| Script          | Description                                      |
|------------------|---------------------------------------------------|
| `npm start`       | Runs the server with nodemon                     |
| `npm run seed`    | Runs `prisma/seed.js` to populate sample data     |
| `npm run format`  | Formats the codebase with Prettier                |

Additional CLI helper (not an npm script):
```bash
node scripts/gen-feature.js <folder_name>   # scaffolds a new module folder
```

---

## 7. API Overview

All routes are mounted under `/api`:

| Base path            | Module      | Notes                                             |
|-----------------------|-------------|----------------------------------------------------|
| `/api/otp`            | otp         | `POST /send-otp`, `POST /verify-otp` (public, rate-limited) |
| `/api/user`            | user        | Address CRUD + profile (auth required)            |
| `/api/admin`           | admin       | `POST /login` (public), `GET /stats`, `GET /users` (admin only) |
| `/api/products`        | product     | Public list/detail/related; admin create/update/delete |
| `/api/cart`            | cart        | Save & fetch cart (auth required)                 |
| `/api/order`           | order       | Create draft order, user order history, admin order views |
| `/api/payment`         | payment     | Razorpay order creation, payment verification, COD placement |
| `/api/homepage`        | homepage    | Public banners & new arrivals; admin banner/new-arrival management |

Full request/response schemas are documented via Swagger at `/api-docs` once the server is running.

---

## 8. Authentication

- JWT-based auth via the `authenticate` middleware (expects a bearer token).
- `authorizeAdminOnly` middleware restricts routes to users with `role: "admin"` in the database.
- OTP login (`/api/otp`) is the primary customer sign-in flow; OTPs are stored in Redis with a 5-minute expiry and delivered via MSG91 SMS.

---

## 9. Background Jobs

BullMQ workers are initialized on server start (`src/jobs/index.js`):
- **imageWorker** — processes/optimizes uploaded images (via `sharp`) before pushing to S3.
- **clearCartWorker** — clears abandoned/stale carts on a schedule.

These require a reachable Redis instance to function.

---

## 10. Notes / Known Gaps

- `docker-compose.yml` and `Dockerfile` exist in the repo but are currently empty placeholders — containerization is not yet implemented.
- The `inventory` module currently has route/controller/service files scaffolded but no implemented logic.
- `.env` is git-ignored; never commit real credentials.
