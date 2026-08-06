const paymentService = require('./payment.service');
const CustomError = require('@utils/customError');
const prisma = require('@config/prisma');

exports.createOrderid = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // 🟡 Step 1: Find the latest draft order of the user
    const draftOrder = await prisma.order.findFirst({
      where: {
        userId,
        status: 'draft',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!draftOrder || draftOrder.total <= 0) {
      throw new CustomError('No valid draft order', 401);
    }

    // 🟡 Step 2: Create Razorpay Order ID with amount
    const razorpayOrder = await paymentService.createRazorpayOrder({
      amount: draftOrder.total * 100, // Convert to paise
      currency: 'INR',
      receipt: `order_${draftOrder.id}`,
      order_id: draftOrder.id,
    });

    res.sendResponse({
      message: 'Razorpay order created successfully',
      data: {
        order: razorpayOrder,
        key_id: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (error) {
    next(error);
  }
};


exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    const isValid = paymentService.verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      throw new CustomError('Invalid signature', 400);
    }

    // Idempotent: a second call for the same order (client retry, double
    // submit, or a race with the webhook) just confirms it's already paid
    // instead of re-applying the update.
    const { order, alreadyProcessed } = await paymentService.updateOrderAfterPayment(
      razorpay_order_id,
      razorpay_payment_id
    );

    res.sendResponse({
      message: alreadyProcessed
        ? 'Payment already verified'
        : 'Payment verified successfully',
      data: { success: true, alreadyProcessed, orderId: order.id },
    });
  } catch (error) {
    next(error);
  }
};

// 🔔 Razorpay webhook — the source of truth for payment status.
// Unlike /verify, this fires from Razorpay's servers whenever a payment's
// status actually changes, so it's what reconciles orders whose customer
// closed the tab (or lost network) right after paying and never called /verify.
exports.razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];

    if (!signature || !req.rawBody) {
      throw new CustomError('Missing signature or request body', 400);
    }

    const isValid = paymentService.verifyWebhookSignature(
      req.rawBody,
      signature
    );

    if (!isValid) {
      throw new CustomError('Invalid webhook signature', 400);
    }

    // req.body is already the parsed JSON event (see verify() in app.js,
    // which captures raw bytes alongside the normal express.json() parse).
    await paymentService.handleRazorpayWebhookEvent(req.body);

    // Razorpay retries (exponential backoff, up to ~24h) on anything but a
    // 2xx, and expects a fast response — we've already applied the update,
    // so ack now rather than doing more work on this request.
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
};

exports.placeCODOrder = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { orderId, method } = req.body;

    if (method !== 'cod') {
      throw new CustomError('Invalid method', 401);
    }

    const result = await paymentService.handleCODOrder(orderId, userId);

    res.sendResponse({
      message: result.alreadyProcessed
        ? 'COD order already placed'
        : 'COD order placed successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

