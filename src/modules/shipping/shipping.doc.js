/**
 * @swagger
 * tags:
 *   - name: Shipping
 *     description: Ekart Logistics shipping operations (serviceability, shipment creation, tracking, cancellation)
 */

/**
 * @swagger
 * /api/shipping/delivery-config:
 *   get:
 *     tags:
 *       - Shipping
 *     summary: Get the backend-configured delivery pricing rule
 *     description: >
 *       Returns the flat delivery-charge rule currently in effect
 *       (FREE_DELIVERY_THRESHOLD / DELIVERY_CHARGE — see src/config/env.js).
 *       Public, cacheable, and safe to call before a cart or draft order
 *       exists — this is what the frontend uses instead of hardcoding its
 *       own copy of these numbers, so a backend-side config change (an env
 *       var edit) is reflected on the frontend without a separate deploy.
 *     responses:
 *       200:
 *         description: Delivery configuration fetched successfully
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
 *                     freeDeliveryThreshold:
 *                       type: number
 *                       example: 600
 *                     deliveryCharge:
 *                       type: number
 *                       example: 49
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
 *               subtotal:
 *                 type: number
 *                 description: >
 *                   Optional. When provided, the response also includes
 *                   deliveryCharge/freeDeliveryThreshold/freeDeliveryEligible
 *                   computed for this amount, so a single call can answer
 *                   serviceability and pricing together.
 *                 example: 799
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
 *                     reason:
 *                       type: string
 *                       nullable: true
 *                       enum: [INVALID_FORMAT, INVALID_PINCODE, AREA_NOT_COVERED, null]
 *                       description: >
 *                         Why `serviceable` is false — null when it's true.
 *                         INVALID_FORMAT means the pincode is empty or not
 *                         even shaped like a 6-digit Indian pincode (checked
 *                         locally, without calling Ekart — this normally
 *                         can't happen via this route since the request body
 *                         is already validated to 422 first, but the same
 *                         check runs server-side wherever serviceability is
 *                         checked, including internal callers that skip this
 *                         route). INVALID_PINCODE means the pincode is
 *                         well-formed but Ekart doesn't recognize it at all.
 *                         AREA_NOT_COVERED means it's a real pincode Ekart
 *                         just doesn't deliver to (yet).
 *                     estimatedDays:
 *                       type: integer
 *                       nullable: true
 *                     estimatedDeliveryDate:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       description: >
 *                         Concrete delivery-by date derived from estimatedDays
 *                         (or an explicit date from Ekart, once confirmed) —
 *                         null when the pincode isn't serviceable.
 *                       example: "2026-08-15T00:00:00.000Z"
 *                     codAvailable:
 *                       type: boolean
 *                     deliveryCharge:
 *                       type: number
 *                       description: Only present when `subtotal` was provided in the request.
 *                       example: 49
 *                     freeDeliveryThreshold:
 *                       type: number
 *                       description: Only present when `subtotal` was provided in the request.
 *                       example: 600
 *                     freeDeliveryEligible:
 *                       type: boolean
 *                       description: Only present when `subtotal` was provided in the request.
 *       422:
 *         description: Validation failed (malformed pincode — not 6 digits)
 *       503:
 *         description: Could not reach Ekart to check serviceability right now — try again shortly
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
 *     description: >
 *       Polls Ekart for the latest status and refreshes our own record.
 *       Accessible to the order's owner or an admin. The returned Shipment
 *       includes `estimatedDeliveryDate` (set when the shipment was created,
 *       and refreshed here if Ekart returns a revised one) whenever the
 *       backend has one to show.
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
