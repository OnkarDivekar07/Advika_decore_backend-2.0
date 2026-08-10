/**
 * @swagger
 * /api/products:
 *   post:
 *     summary: Create a new product
 *     tags:
 *       - Products
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - category
 *               - brand
 *               - price
 *               - stock
 *               - description
 *               - isNewArrival
 *               - images
 *             properties:
 *               name:
 *                 type: string
 *                 example: Heavy Duty Mud Flap
 *               category:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["Truck", "Tempo"]
 *               brand:
 *                 type: string
 *                 example: Advika
 *               price:
 *                 type: number
 *                 example: 299.99
 *               stock:
 *                 type: integer
 *                 example: 50
 *               description:
 *                 type: string
 *                 example: High quality and durable mud flap for heavy vehicles.
 *               isNewArrival:
 *                 type: boolean
 *                 example: true
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       200:
 *         description: Product upload queued successfully
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
 *                   example: Product upload queued successfully.
 *                 data:
 *                   type: object
 *                   properties:
 *                     jobId:
 *                       type: string
 *                       example: "abc123"
 *       400:
 *         description: Validation error or bad request
 *       401:
 *         description: Unauthorized (no or invalid token)
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/products/{id}:
 *   patch:
 *     summary: Partially update a product and queue image processing
 *     tags:
 *       - Products
 *     description: Allows admin to partially update product details and optionally upload new images. The update is queued for background processing.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID of the product to update
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: Premium Car Seat Cover
 *               description:
 *                 type: string
 *                 example: Waterproof leather seat cover for SUVs
 *               category:
 *                 type: string
 *                 example: seat-covers
 *               price:
 *                 type: number
 *                 example: 1499
 *               brand:
 *                 type: string
 *                 example: Advika
 *               stock:
 *                 type: integer
 *                 example: 25
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Upload up to 5 images
 *     responses:
 *       200:
 *         description: Product update queued successfully
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
 *                   example: Product update queued successfully.
 *                 data:
 *                   type: object
 *                   properties:
 *                     jobId:
 *                       type: string
 *                       example: "b7d74b42-91d9-40e6-b52a-46a9c24876fd"
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Product not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Get all products with search, filter, and pagination
 *     tags:
 *       - Products
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number (default is 1)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of items per page (default is 10)
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *         description: Field to sort by (e.g., name, createdAt)
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order (asc or desc)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term (applies to product name)
 *       - in: query
 *         name: categoryId
 *         schema:
 *           type: string
 *         description: Filter by Category ID
 *       - in: query
 *         name: brandId
 *         schema:
 *           type: string
 *         description: Filter by Brand ID
 *     responses:
 *       200:
 *         description: List of products with metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: Products fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Product'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/products/batch:
 *   get:
 *     summary: Get multiple products by id
 *     description: >
 *       Bulk lookup used by the frontend to revalidate a guest
 *       (localStorage-only) cart's price/stock/availability against live
 *       product data in one call. Ids that don't match a live, non-deleted
 *       product are simply omitted from the response rather than erroring.
 *     tags:
 *       - Products
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         schema:
 *           type: string
 *         description: Comma-separated product ids (max 50, deduped server-side)
 *         example: 64f1c2...,64f1c3...
 *     responses:
 *       200:
 *         description: Matching, currently-available products
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: Products fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Product'
 *       422:
 *         description: ids missing, empty, or over the 50-id cap
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /api/products/{id}:
 *   get:
 *     summary: Get a product by ID
 *     tags:
 *       - Products
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the product to retrieve
 *     responses:
 *       200:
 *         description: Product fetched successfully
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
 *                   example: Product fetched successfully
 *                 data:
 *                   $ref: '#/components/schemas/Product'
 *       404:
 *         description: Product not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/products/{id}/related:
 *   get:
 *     summary: Get related products by product ID
 *     tags:
 *       - Products
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID of the product to find related products for
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Related products fetched successfully
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
 *                   example: Related products fetched successfully
 *                 data:
 *                   type: array
 *       404:
 *         description: Product not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Server error
 */
