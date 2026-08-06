/**
 * @swagger
 * tags:
 *   - name: Inventory
 *     description: Admin-only stock management
 */

/**
 * @swagger
 * /api/inventory/low-stock:
 *   get:
 *     tags:
 *       - Inventory
 *     summary: List low-stock products
 *     description: Returns non-deleted products at or below the given stock threshold, lowest stock first.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Stock level (inclusive) at or below which a product is considered low
 *     responses:
 *       200:
 *         description: Low stock products fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Low stock products fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       brand:
 *                         type: string
 *                       stock:
 *                         type: integer
 *       403:
 *         description: Admin access required
 */

/**
 * @swagger
 * /api/inventory/{productId}:
 *   get:
 *     tags:
 *       - Inventory
 *     summary: Get current stock for a product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stock fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Stock fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     brand:
 *                       type: string
 *                     stock:
 *                       type: integer
 *       404:
 *         description: Product not found
 *       403:
 *         description: Admin access required
 *   patch:
 *     tags:
 *       - Inventory
 *     summary: Manually adjust a product's stock
 *     description: >
 *       For restocks and corrections. 'decrement' reuses the same atomic,
 *       race-safe primitive the order/payment flow uses, so it can't push
 *       stock negative even under concurrent requests — it returns 409 if
 *       the requested quantity isn't available.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - quantity
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [set, increment, decrement]
 *               quantity:
 *                 type: integer
 *                 minimum: 0
 *                 example: 10
 *     responses:
 *       200:
 *         description: Stock updated successfully
 *       404:
 *         description: Product not found
 *       409:
 *         description: Insufficient stock for a decrement
 *       403:
 *         description: Admin access required
 */
