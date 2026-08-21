/**
 * @swagger
 * /api/admin/me:
 *   get:
 *     summary: Get the currently-authenticated admin's profile
 *     description: >
 *       Re-verifies the session against the database (not just the JWT
 *       payload), so a deleted or demoted admin account gets a 401 even
 *       within an otherwise-unexpired token's lifetime.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current admin fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Current admin fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: 64f1c2b3e4b0a2d3c4e5f6a7
 *                     name:
 *                       type: string
 *                       example: Admin User
 *                     email:
 *                       type: string
 *                       example: admin@example.com
 *                     role:
 *                       type: string
 *                       example: admin
 *       401:
 *         description: Missing/invalid/expired token, or the account is no longer an admin
 *       403:
 *         description: Forbidden
 */

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get platform-wide statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Stats fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                       example: 120
 *                     totalOrders:
 *                       type: integer
 *                       example: 300
 *                     totalProducts:
 *                       type: integer
 *                       example: 80
 *                     deliveredOrders:
 *                       type: integer
 *                       example: 200
 *                     pendingOrders:
 *                       type: integer
 *                       example: 50
 *                     totalRevenue:
 *                       type: number
 *                       format: float
 *                       example: 150000.75
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get all users with purchase stats
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of users per page
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [admin, customer, superadmin]
 *           default: customer
 *         description: Filter users by role
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *           maxLength: 100
 *         description: Matches against name, email, or phone (case-insensitive)
 *     responses:
 *       200:
 *         description: Users fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Users fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: 12345
 *                       name:
 *                         type: string
 *                         example: John Doe
 *                       email:
 *                         type: string
 *                         example: john@example.com
 *                       phone:
 *                         type: string
 *                         example: +918668441638
 *                       role:
 *                         type: string
 *                         example: customer
 *                       joinedOn:
 *                         type: string
 *                         format: date-time
 *                         example: 2024-01-01T12:00:00Z
 *                       addressSummary:
 *                         type: object
 *                         nullable: true
 *                         description: The customer's default address, or their first address if none is marked default. Null if they have none.
 *                         properties:
 *                           houseArea:
 *                             type: string
 *                             example: ABC Nagar
 *                           area:
 *                             type: string
 *                             example: Sector 5
 *                           city:
 *                             type: string
 *                             example: Pune
 *                           state:
 *                             type: string
 *                             example: Maharashtra
 *                           pincode:
 *                             type: string
 *                             example: 411001
 *                       totalOrders:
 *                         type: integer
 *                         example: 3
 *                       totalSpent:
 *                         type: number
 *                         format: float
 *                         example: 1200.5
 *                       lastOrderDate:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         example: 2024-05-10T14:20:00Z
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       example: 100
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     totalPages:
 *                       type: integer
 *                       example: 10
 *                     limit:
 *                       type: integer
 *                       example: 10
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */

/**
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     summary: Get a single customer's detail view
 *     description: >
 *       Profile, all saved addresses, the 10 most recent orders, and a
 *       full-history order summary. Never includes password, OTP, auth
 *       tokens, or payment secrets.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId of the user
 *     responses:
 *       200:
 *         description: User fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: User fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     email:
 *                       type: string
 *                     phone:
 *                       type: string
 *                     role:
 *                       type: string
 *                       example: customer
 *                     joinedOn:
 *                       type: string
 *                       format: date-time
 *                     addresses:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           phone:
 *                             type: string
 *                           houseArea:
 *                             type: string
 *                           area:
 *                             type: string
 *                           city:
 *                             type: string
 *                           state:
 *                             type: string
 *                           pincode:
 *                             type: string
 *                           landmark:
 *                             type: string
 *                           deliveryInstructions:
 *                             type: string
 *                           isDefault:
 *                             type: boolean
 *                     recentOrders:
 *                       type: array
 *                       description: The 10 most recent orders (see orderSummary for full-history totals)
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           status:
 *                             type: string
 *                           paymentStatus:
 *                             type: string
 *                           total:
 *                             type: number
 *                             format: float
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                     orderSummary:
 *                       type: object
 *                       properties:
 *                         totalOrders:
 *                           type: integer
 *                         totalSpent:
 *                           type: number
 *                           format: float
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 *       422:
 *         description: Malformed id
 */

/**
 * @swagger
 * /api/admin/login:
 *   post:
 *     summary: Admin login
 *     tags:
 *       - Admin
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@example.com
 *                 description: Admin email address
 *               password:
 *                 type: string
 *                 format: password
 *                 example: secret123
 *                 description: Admin password
 *     responses:
 *       200:
 *         description: Successful login
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 token:
 *                   type: string
 *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *                 message:
 *                   type: string
 *                   example: Login successful
 *       401:
 *         description: Invalid email/password, or the account is not an admin
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Incorrect password
 *       422:
 *         description: Validation error (missing/malformed email or password)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Validation failed
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *       429:
 *         description: Too many login attempts for this email — retry later
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Too many login attempts. Please try again later.
 */

/**
 * @swagger
 * /api/products/{id}:
 *   delete:
 *     summary: Delete a product by ID
 *     tags:
 *       - Products
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: The ID of the product to delete
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Product deleted successfully
 *                 data:
 *                   type: string
 *                   nullable: true
 *                   example: null
 *       404:
 *         description: Product not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * @swagger
 * /api/admin/analytics/overview:
 *   get:
 *     summary: PHASE 11 — date-range-scoped business KPI summary
 *     description: >
 *       Backend-authoritative KPI overview, optionally scoped to a
 *       dateFrom/dateTo window. Complements (never replaces) GET
 *       /api/admin/stats, which stays an unfiltered all-time snapshot.
 *       Every field's precise backend definition ships in the response's
 *       own `definitions` object, so the panel never hardcodes what a
 *       number means. `grossRevenue` is explicitly gross revenue on paid
 *       orders, never profit — the catalog has no recorded product cost,
 *       so no profit/margin/inventory-valuation figure exists anywhere in
 *       this API.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *         description: Inclusive lower bound (ISO 8601). Omit for an unbounded/all-time lower bound.
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *         description: Inclusive upper bound, extended to the end of that calendar day (ISO 8601). Omit for an unbounded upper bound.
 *     responses:
 *       200:
 *         description: Analytics overview fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Analytics overview fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     range:
 *                       type: object
 *                       properties:
 *                         from: { type: string, nullable: true, format: date-time }
 *                         to: { type: string, nullable: true, format: date-time }
 *                     grossRevenue: { type: number, example: 128450.5 }
 *                     paidOrderCount: { type: integer, example: 64 }
 *                     averageOrderValue: { type: number, example: 2007.04 }
 *                     orderCount: { type: integer, example: 71 }
 *                     deliveredOrders: { type: integer, example: 58 }
 *                     pendingOrders: { type: integer, example: 4 }
 *                     newCustomers: { type: integer, example: 22 }
 *                     totalActiveProducts: { type: integer, example: 96 }
 *                     definitions:
 *                       type: object
 *                       description: Backend-authoritative definition string for every field above, keyed by field name.
 *       401:
 *         description: Missing/invalid/expired token
 *       403:
 *         description: Forbidden — not an admin account
 *       422:
 *         description: dateFrom/dateTo malformed, or dateTo before dateFrom
 */

/**
 * @swagger
 * /api/admin/analytics/revenue-trend:
 *   get:
 *     summary: PHASE 11 — backend-aggregated paid-revenue time series
 *     description: >
 *       Chartable revenue-over-time data, bucketed by day, week, or month.
 *       Bucketing is computed inside MongoDB via an aggregation pipeline
 *       (never by pulling every order row into the API process), so it
 *       stays cheap as order volume grows. Defaults to a trailing 30-day
 *       window when neither dateFrom nor dateTo is given; the resolved
 *       window is always echoed back in `range`. The returned `buckets`
 *       array only ever contains periods that had at least one paid
 *       order — it never fabricates a zero-value point for a period with
 *       no data.
 *     tags: [Admin, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: granularity
 *         schema:
 *           type: string
 *           enum: [day, week, month]
 *           default: day
 *     responses:
 *       200:
 *         description: Revenue trend fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Revenue trend fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     range:
 *                       type: object
 *                       properties:
 *                         from: { type: string, format: date-time }
 *                         to: { type: string, format: date-time }
 *                     granularity:
 *                       type: string
 *                       example: day
 *                     buckets:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           label: { type: string, example: '2026-08-14' }
 *                           periodStart: { type: string, format: date-time }
 *                           periodEnd: { type: string, format: date-time }
 *                           revenue: { type: number, example: 15400 }
 *                           orderCount: { type: integer, example: 7 }
 *                     definitions:
 *                       type: object
 *                       description: Backend-authoritative definition string for `revenue` and `orderCount`.
 *       401:
 *         description: Missing/invalid/expired token
 *       403:
 *         description: Forbidden — not an admin account
 *       422:
 *         description: dateFrom/dateTo/granularity malformed, or dateTo before dateFrom
 */

/**
 * @swagger
 * /api/admin/alerts:
 *   get:
 *     summary: PHASE 14 — operational "needs attention" alerts feed
 *     description: >
 *       Aggregates real, currently-true operational conditions: low-stock
 *       products, orders still awaiting confirmation, payment attempts
 *       that need a human look (failed/timeout/unknown), and shipments
 *       that failed delivery or are being returned to origin. Every
 *       section's `count` is the true total; `items` is capped (oldest
 *       pending orders first, most-recent exceptions first) since this is
 *       a "what needs attention right now" panel, not a paginated
 *       browser. Nothing here is synthesized — an item stops appearing on
 *       the next read once the underlying condition is resolved (stock
 *       restocked, order confirmed, payment/shipment issue resolved).
 *       There is no read/unread state: the backend has no per-admin
 *       acknowledgment storage for these conditions.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lowStockThreshold
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 10
 *         description: Same meaning as GET /api/inventory/low-stock's own threshold.
 *     responses:
 *       200:
 *         description: Operational alerts fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Operational alerts fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     lowStock:
 *                       type: object
 *                       properties:
 *                         threshold: { type: integer, example: 10 }
 *                         count: { type: integer, example: 3 }
 *                         items:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: string }
 *                               name: { type: string }
 *                               brand: { type: string }
 *                               stock: { type: integer }
 *                     pendingOrders:
 *                       type: object
 *                       properties:
 *                         count: { type: integer, example: 5 }
 *                         items:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: string }
 *                               total: { type: number }
 *                               createdAt: { type: string, format: date-time }
 *                               user:
 *                                 type: object
 *                                 properties:
 *                                   name: { type: string }
 *                                   email: { type: string, nullable: true }
 *                     paymentExceptions:
 *                       type: object
 *                       properties:
 *                         count: { type: integer, example: 2 }
 *                         items:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id: { type: string }
 *                               total: { type: number }
 *                               paymentStatus:
 *                                 type: string
 *                                 enum: [failed, timeout, unknown]
 *                               createdAt: { type: string, format: date-time }
 *                               user:
 *                                 type: object
 *                                 properties:
 *                                   name: { type: string }
 *                                   email: { type: string, nullable: true }
 *                     shipmentExceptions:
 *                       type: object
 *                       properties:
 *                         count: { type: integer, example: 1 }
 *                         items:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               orderId: { type: string }
 *                               trackingId: { type: string, nullable: true }
 *                               status:
 *                                 type: string
 *                                 enum: [DELIVERY_FAILED, RTO_INITIATED]
 *                               courierPartner: { type: string }
 *                               lastLocation: { type: string, nullable: true }
 *                               updatedAt: { type: string, format: date-time }
 *                               total: { type: number, nullable: true }
 *                               user:
 *                                 type: object
 *                                 nullable: true
 *                                 properties:
 *                                   name: { type: string }
 *                                   email: { type: string, nullable: true }
 *                     generatedAt:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Missing/invalid/expired token
 *       403:
 *         description: Forbidden — not an admin account
 *       422:
 *         description: lowStockThreshold malformed
 */
