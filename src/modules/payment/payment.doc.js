/**
 * @swagger
 * tags:
 *   - name: Payment
 *     description: Payment-related operations (Razorpay + COD)
 */

/**
 * @swagger
 * /api/payment/create-orderid:
 *   post:
 *     tags:
 *       - Payment
 *     summary: Create Razorpay Order ID
 *     description: Generates a Razorpay order ID for the authenticated user's latest draft order.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Razorpay order created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Razorpay order created successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     order:
 *                       type: object
 *                       description: Razorpay order object
 *                     key_id:
 *                       type: string
 *                       example: rzp_test_xxxxxxxxxx
 *       401:
 *         description: No valid draft order or unauthenticated
 */

/**
 * @swagger
 * /api/payment/verify:
 *   post:
 *     tags:
 *       - Payment
 *     summary: Verify Razorpay Payment
 *     description: Verifies the Razorpay payment using the signature.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - razorpay_order_id
 *               - razorpay_payment_id
 *               - razorpay_signature
 *             properties:
 *               razorpay_order_id:
 *                 type: string
 *                 example: order_LvR9yA1WXiY4ig
 *               razorpay_payment_id:
 *                 type: string
 *                 example: pay_LvR9xEQBq2jFZv
 *               razorpay_signature:
 *                 type: string
 *                 example: abc123def456signature
 *     responses:
 *       200:
 *         description: Payment verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Payment verified successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     alreadyProcessed:
 *                       type: boolean
 *                       description: true if this order was already verified by an earlier call (or the webhook) — the request is idempotent
 *                       example: false
 *                     orderId:
 *                       type: string
 *       400:
 *         description: Invalid signature
 */

/**
 * @swagger
 * /api/payment/webhook:
 *   post:
 *     tags:
 *       - Payment
 *     summary: Razorpay webhook (server-to-server)
 *     description: >
 *       Called by Razorpay, not the frontend. Verified via the
 *       X-Razorpay-Signature header (HMAC-SHA256 of the raw body, keyed with
 *       RAZORPAY_WEBHOOK_SECRET) rather than a user JWT. This is the source
 *       of truth for payment status — it reconciles orders even if the
 *       client never called /api/payment/verify (e.g. the tab closed right
 *       after paying). Configure this URL in the Razorpay Dashboard under
 *       Settings > Webhooks, subscribed to payment.captured and
 *       payment.failed.
 *     parameters:
 *       - in: header
 *         name: X-Razorpay-Signature
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Razorpay event payload (event, payload.payment.entity, ...)
 *     responses:
 *       200:
 *         description: Event received and applied (or ignored, if not a payment.captured/payment.failed event)
 *       400:
 *         description: Missing or invalid signature
 */

/**
 * @swagger
 * /api/payment/cod:
 *   post:
 *     tags:
 *       - Payment
 *     summary: Place Cash On Delivery (COD) Order
 *     description: Places an order with COD payment method after validating the request.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *               - method
 *             properties:
 *               orderId:
 *                 type: string
 *                 example: order_xyz123
 *               method:
 *                 type: string
 *                 enum: [cod]
 *                 example: cod
 *     responses:
 *       200:
 *         description: COD order placed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: COD order placed successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     order:
 *                       type: object
 *                       description: Updated order data
 *       401:
 *         description: Unauthorized or invalid method
 */
