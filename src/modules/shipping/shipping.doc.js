/**
 * @swagger
 * tags:
 *   - name: Shipping
 *     description: Ekart Logistics shipping operations (serviceability, shipment creation, tracking, cancellation)
 */

/**
 * @swagger
 * /api/shipping/serviceability:
 *   post:
 *     tags:
 *       - Shipping
 *     summary: Check pincode serviceability + delivery estimate
 *     description: Public endpoint used on product/checkout pages to check if Ekart delivers to a pincode before an order exists.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pincode
 *             properties:
 *               pincode:
 *                 type: string
 *                 example: "560001"
 *               paymentMode:
 *                 type: string
 *                 enum: [COD, PREPAID]
 *                 example: PREPAID
 *               weightKg:
 *                 type: number
 *                 example: 1.2
 *     responses:
 *       200:
 *         description: Serviceability checked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     serviceable:
 *                       type: boolean
 *                     estimatedDays:
 *                       type: integer
 *                       nullable: true
 *                     codAvailable:
 *                       type: boolean
 *       422:
 *         description: Validation failed
 */

/**
 * @swagger
 * /api/shipping/{orderId}/create:
 *   post:
 *     tags:
 *       - Shipping
 *     summary: Create a shipment for a confirmed order
 *     description: Manually triggers shipment creation with Ekart for an order that's already confirmed. Idempotent — calling it again for an order that already has a shipment returns the existing one.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Shipment created (or already existed)
 *       400:
 *         description: Order isn't in a shippable state
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Order not found
 */

/**
 * @swagger
 * /api/shipping/{orderId}/track:
 *   get:
 *     tags:
 *       - Shipping
 *     summary: Get the latest tracking status for an order's shipment
 *     description: Polls Ekart for the latest status and refreshes our own record. Accessible to the order's owner or an admin.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Shipment status fetched successfully
 *       403:
 *         description: Not authorized to view this shipment
 *       404:
 *         description: Order or shipment not found
 */

/**
 * @swagger
 * /api/shipping/{orderId}/cancel:
 *   post:
 *     tags:
 *       - Shipping
 *     summary: Cancel a shipment before it's out for delivery
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 example: Customer requested cancellation
 *     responses:
 *       200:
 *         description: Shipment cancelled successfully
 *       400:
 *         description: Shipment already in a terminal state and can't be cancelled
 *       403:
 *         description: Not authorized to cancel this shipment
 *       404:
 *         description: Order or shipment not found
 */

/**
 * @swagger
 * /api/shipping/webhook:
 *   post:
 *     tags:
 *       - Shipping
 *     summary: Ekart shipment status webhook (server-to-server)
 *     description: >
 *       Called by Ekart, not the frontend. Verified via an HMAC signature
 *       header (scheme TBD — confirm against Ekart's webhook docs) rather
 *       than a user JWT. Reconciles shipment + order status independently
 *       of whether the client ever calls GET /track. Configure this URL in
 *       your Ekart dashboard's webhook settings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Ekart status event payload (tracking_id/awb_number, status_code, current_location, ...)
 *     responses:
 *       200:
 *         description: Event received and applied
 *       400:
 *         description: Missing or invalid signature
 */
