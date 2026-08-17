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
 *           enum: [admin, customer]
 *           default: customer
 *         description: Filter users by role
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
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                         example: 2024-01-01T12:00:00Z
 *                       addresses:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             houseArea:
 *                               type: string
 *                               example: ABC Nagar
 *                             city:
 *                               type: string
 *                               example: Pune
 *                             state:
 *                               type: string
 *                               example: Maharashtra
 *                             pincode:
 *                               type: string
 *                               example: 411001
 *                       orders:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             total:
 *                               type: number
 *                               format: float
 *                               example: 1200.5
 *                             createdAt:
 *                               type: string
 *                               format: date-time
 *                               example: 2024-05-10T14:20:00Z
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
