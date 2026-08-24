/**
 * @swagger
 * /api/order:
 *   post:
 *     summary: Create or update a draft order
 *     tags:
 *       - Orders
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - selectedAddressId
 *             properties:
 *               selectedAddressId:
 *                 type: string
 *                 format: uuid
 *                 description: The ID of the selected shipping address
 *               couponCode:
 *                 type: string
 *                 description: >
 *                   Optional coupon code to apply. Re-validated server-side
 *                   against the live cart — no coupon system exists yet, so
 *                   any non-empty value currently fails with 404.
 *     responses:
 *       201:
 *         description: Draft order created or updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     orderId:
 *                       type: string
 *                       format: uuid
 *                     totalAmount:
 *                       type: number
 *                       format: float
 *                     itemCount:
 *                       type: integer
 *       400:
 *         description: Missing address ID or cart is empty or invalid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized (user not authenticated)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Address does not belong to user or invalid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Order is already being created (rate-limited)
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
 * /api/orders/all:
 *   get:
 *     summary: Get all orders (Admin only) — paginated order workbench list
 *     description: >
 *       Never includes draft orders (in-progress carts that were never
 *       placed). All filters are optional and combine with AND; `search`
 *       matches customer name/email, and additionally matches the order id
 *       exactly when the term is shaped like one.
 *     tags:
 *       - Orders
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, shipped, delivered, cancelled, returned]
 *       - in: query
 *         name: paymentStatus
 *         schema:
 *           type: string
 *           enum: [pending, attempted, processing, paid, failed, cancelled, timeout, unknown, refunded, cod_pending]
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *         description: Inclusive lower bound on createdAt (ISO 8601)
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *         description: Inclusive upper bound on createdAt (ISO 8601), extended to end-of-day
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: Matches customer name/email, or an exact order id
 *     responses:
 *       200:
 *         description: List of orders fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: All orders fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       user:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           email:
 *                             type: string
 *                             nullable: true
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       total:
 *                         type: number
 *                       status:
 *                         type: string
 *                       paymentStatus:
 *                         type: string
 *                       shipmentStatus:
 *                         type: string
 *                         nullable: true
 *                       trackingId:
 *                         type: string
 *                         nullable: true
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       422:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * @swagger
 * /api/orders/history:
 *   get:
 *     summary: Get a paginated list of the logged-in user's placed orders ("My Orders")
 *     description: >
 *       Never includes the in-progress draft order (see GET /api/orders for
 *       that) - only orders that have actually been placed (pending,
 *       confirmed, shipped, delivered, cancelled, or returned), newest first.
 *     tags:
 *       - Orders
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *     responses:
 *       200:
 *         description: Order history fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: Order history fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       total:
 *                         type: number
 *                       subtotal:
 *                         type: number
 *                       deliveryCharge:
 *                         type: number
 *                       discount:
 *                         type: number
 *                       status:
 *                         type: string
 *                       paymentStatus:
 *                         type: string
 *                       payment_order_id:
 *                         type: string
 *                         nullable: true
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       orderItems:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             quantity:
 *                               type: integer
 *                             price:
 *                               type: number
 *                             product:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                 name:
 *                                   type: string
 *                                 images:
 *                                   type: array
 *                                   items:
 *                                     type: string
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Invalid page/limit
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */

/**
 * @swagger
 * /api/orders/{id}:
 *   get:
 *     summary: Get a specific order by ID (owner or admin)
 *     tags:
 *       - Orders
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 *         required: true
 *         description: Order ID
 *     responses:
 *       200:
 *         description: Order fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: Order fetched successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     total:
 *                       type: number
 *                     subtotal:
 *                       type: number
 *                     deliveryCharge:
 *                       type: number
 *                     discount:
 *                       type: number
 *                     couponCode:
 *                       type: string
 *                       nullable: true
 *                     status:
 *                       type: string
 *                       enum: [draft, pending, confirmed, shipped, delivered, cancelled, returned]
 *                     paymentStatus:
 *                       type: string
 *                       enum: [pending, attempted, processing, paid, failed, cancelled, timeout, unknown, refunded, cod_pending]
 *                     payment_order_id:
 *                       type: string
 *                       nullable: true
 *                       description: Razorpay order id (order_xxx). Never a secret — safe to display.
 *                     payment_id:
 *                       type: string
 *                       nullable: true
 *                       description: Razorpay payment id (pay_xxx) that captured this order, set by the webhook. Never a secret — safe to display.
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                     user:
 *                       type: object
 *                       description: Customer identity. Available to the order's owner and to admins only.
 *                       properties:
 *                         id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         email:
 *                           type: string
 *                         phone:
 *                           type: string
 *                     address:
 *                       type: object
 *                       description: Delivery address snapshot at the time the order was placed.
 *                     orderItems:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           quantity:
 *                             type: integer
 *                           price:
 *                             type: number
 *                             description: Price locked in at order time — may differ from the product's current live price.
 *                           product:
 *                             type: object
 *                             properties:
 *                               name:
 *                                 type: string
 *                     shipment:
 *                       type: object
 *                       nullable: true
 *                       description: >
 *                         Last-known persisted shipment state (a plain DB read — not a live
 *                         Ekart poll; see POST /api/shipping/{orderId}/create,
 *                         GET /api/shipping/{orderId}/track, POST /api/shipping/{orderId}/cancel
 *                         for the actions that create/refresh/cancel it). null when no
 *                         shipment has been created for this order yet.
 *                       properties:
 *                         id:
 *                           type: string
 *                         trackingId:
 *                           type: string
 *                           nullable: true
 *                         awbNumber:
 *                           type: string
 *                           nullable: true
 *                         courierPartner:
 *                           type: string
 *                         status:
 *                           type: string
 *                           enum: [CREATED, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, DELIVERY_FAILED, RTO_INITIATED, RTO_DELIVERED, CANCELLED]
 *                         paymentMode:
 *                           type: string
 *                         codAmount:
 *                           type: number
 *                         lastLocation:
 *                           type: string
 *                           nullable: true
 *                         estimatedDeliveryDate:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         lastSyncedAt:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *       404:
 *         description: No order found for this ID
 *       422:
 *         description: Malformed order ID (not a valid ObjectId)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — not this order's owner and not an admin
 */

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Get orders of the logged-in user
 *     tags:
 *       - Orders
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User's orders fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: Orders fetched successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       total:
 *                         type: number
 *                       status:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Unauthorized
 */
