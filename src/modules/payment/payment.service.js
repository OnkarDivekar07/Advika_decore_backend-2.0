const Razorpay = require("razorpay");
const crypto = require("crypto");
const prisma = require('@config/prisma');
const customError=  require('@utils/customError')
const inventoryService = require('@modules/inventory/inventory.service');
const orderService = require('@modules/order/order.service');
const cartQueue = require('../../jobs/queues/clearCartQueue');
const notificationQueue = require('../../jobs/queues/notificationQueue');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createRazorpayOrder = async ({ amount, currency = "INR", receipt, order_id }) => {
  try {
    // 1. Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount,       // in paise
      currency,
      receipt,
    });

    // 2. Update your DB with the Razorpay order ID
    const updateOrderPromise = prisma.order.update({
      where: { id: order_id },
      data: {
        payment_order_id: razorpayOrder.id,
      },
    });

    // 3. Wait for update (useful if you plan to expand with more parallel promises later)
    await Promise.all([updateOrderPromise]);

    return razorpayOrder;
  } catch (err) {
    
    throw new customError("Unable to create payment order.",500);
  }
};



/**
 * Looks up a previously-created Razorpay order by id. Used by createOrderid
 * to decide whether an existing (not-yet-paid) Razorpay order can be reused
 * for a retry instead of minting a new one — see the reuse-or-reconcile
 * comment there for why that matters. Returns null (rather than throwing)
 * on any failure — an unrecognized/expired id, a network blip talking to
 * Razorpay, etc. — so callers can just fall through to creating a fresh
 * order instead of having to special-case this.
 */
exports.fetchRazorpayOrder = async (razorpayOrderId) => {
  try {
    return await razorpay.orders.fetch(razorpayOrderId);
  } catch (err) {
    return null;
  }
};

/**
 * Lists the payment attempts made against a Razorpay order. Used to find a
 * `captured` payment when a Razorpay order comes back `status: "paid"` but
 * our own Order record hasn't been reconciled yet (the client never made it
 * back to call /verify, and the webhook hasn't landed yet either) — see
 * createOrderid. Returns [] on failure rather than throwing, same reasoning
 * as fetchRazorpayOrder above.
 */
exports.fetchOrderPayments = async (razorpayOrderId) => {
  try {
    const result = await razorpay.orders.fetchPayments(razorpayOrderId);
    return result?.items ?? [];
  } catch (err) {
    return [];
  }
};

exports.verifyRazorpaySignature = (order_id, payment_id, signature) => {
  const generatedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(order_id + "|" + payment_id)
    .digest("hex");

  // Use a constant-time comparison so response timing can't leak how many
  // leading characters of the signature matched (defense-in-depth on a
  // payment-security code path).
  const generatedBuffer = Buffer.from(generatedSignature, "utf8");
  const providedBuffer = Buffer.from(String(signature || ""), "utf8");

  if (generatedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuffer, providedBuffer);
};


exports.updateOrderAfterPayment = async (order_id, payment_id) => {
  // /verify can legitimately be hit more than once — the client can retry on
  // a flaky network, double-submit, or race the async webhook hitting the
  // same order first. The filter makes the write a no-op once paymentStatus
  // is already 'paid', and since MongoDB applies a single document's update
  // atomically, only one concurrent caller ever actually wins this flip.
  const result = await prisma.order.updateMany({
    where: {
      payment_order_id: order_id,
      paymentStatus: { not: "paid" },
    },
    data: {
      paymentStatus: "paid",
      status: "confirmed",
      payment_id,
    },
  });

  const order = await prisma.order.findUnique({
    where: { payment_order_id: order_id },
    include: { orderItems: true },
  });

  if (!order) {
    throw new customError("Order not found for this payment", 404);
  }

  if (result.count > 0) {
    // This call is the one that actually flipped the order to paid (not a
    // retry/race that lost) — decrement stock exactly once for it. Razorpay
    // has already captured the money by this point, so unlike COD we can't
    // just reject the order on a shortfall; we decrement what's available
    // and flag the rest for manual handling (refund/backorder) instead.
    const insufficient = await inventoryService.decrementStockForOrder(
      order.orderItems,
      prisma,
      { throwOnInsufficientStock: false }
    );

    if (insufficient.length > 0) {
      console.warn(
        `Order ${order.id} was paid but oversold — insufficient stock for:`,
        insufficient
      );
    }

    // The cart is only cleared once payment is actually confirmed — this is
    // the first point in the /verify flow where that's true.
    await cartQueue.add('clear-cart', { userId: order.userId });
    // Same "only the call that actually flipped it" guard — a duplicate
    // /verify call or a race with the webhook can't queue a second
    // confirmation SMS for the same order.
    await notificationQueue.add('order-confirmation', { orderId: order.id });
  }

  // count === 0 means either this exact call raced a previous one and lost,
  // or /verify is simply being called again after the order was already
  // reconciled (e.g. by the webhook) — either way, already handled, not an error.
  return { order, alreadyProcessed: result.count === 0 };
};



exports.verifyWebhookSignature = (rawBody, signature) => {
  const generatedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody) // Buffer of the exact bytes Razorpay sent — do not use a re-stringified req.body
    .digest("hex");

  // Constant-time comparison, same defense-in-depth as verifyRazorpaySignature above.
  const generatedBuffer = Buffer.from(generatedSignature, "utf8");
  const providedBuffer = Buffer.from(String(signature || ""), "utf8");

  if (generatedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuffer, providedBuffer);
};

/**
 * Applies a verified Razorpay webhook event to our order record. This is the
 * reconciliation path: it runs independently of whether the client ever hit
 * /api/payment/verify, so it's the one place we can trust as the source of
 * truth for "did the money actually land".
 *
 * Every branch is written to be safely re-appliable, since Razorpay retries
 * webhook delivery (same event more than once) whenever it doesn't get a 2xx.
 */
exports.handleRazorpayWebhookEvent = async (event) => {
  const eventType = event?.event;
  const payment = event?.payload?.payment?.entity;

  if (!payment?.order_id) {
    // Nothing to reconcile against (e.g. non-payment events) — ack and ignore.
    return;
  }

  switch (eventType) {
    case "payment.captured": {
      // No-ops once paymentStatus is already 'paid', so a duplicate delivery
      // of this same event can't do anything unexpected.
      const result = await prisma.order.updateMany({
        where: {
          payment_order_id: payment.order_id,
          paymentStatus: { not: "paid" },
        },
        data: {
          paymentStatus: "paid",
          status: "confirmed",
          payment_id: payment.id,
        },
      });

      if (result.count > 0) {
        // Same "actually flipped it" guard as /verify — decrement stock
        // exactly once, on whichever of /verify or this webhook won the race.
        const order = await prisma.order.findUnique({
          where: { payment_order_id: payment.order_id },
          include: { orderItems: true },
        });

        if (order) {
          const insufficient = await inventoryService.decrementStockForOrder(
            order.orderItems,
            prisma,
            { throwOnInsufficientStock: false }
          );

          if (insufficient.length > 0) {
            console.warn(
              `Order ${order.id} was paid but oversold — insufficient stock for:`,
              insufficient
            );
          }

          // Same guard as /verify — only the call that actually flipped the
          // order to paid clears the cart, so a duplicate webhook delivery
          // can't queue redundant clear jobs.
          await cartQueue.add('clear-cart', { userId: order.userId });
          await notificationQueue.add('order-confirmation', { orderId: order.id });
        }
      }
      break;
    }

    case "payment.failed":
      // Guard against ever downgrading an order a 'captured' event already
      // marked paid — Razorpay doesn't guarantee webhook delivery order.
      await prisma.order.updateMany({
        where: {
          payment_order_id: payment.order_id,
          paymentStatus: { not: "paid" },
        },
        data: {
          paymentStatus: "failed",
          payment_id: payment.id,
        },
      });
      break;

    default:
      // Other event types (authorized, refunded, order.paid, etc.) aren't
      // needed for "did the money land" reconciliation — ack and ignore so
      // Razorpay doesn't keep retrying them.
      break;
  }
};

exports.handleCODOrder = async (orderId, userId) => {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch the order to verify ownership
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { orderItems: true },
    });

    if (!order) {
      throw new customError("Order not found", 404);
    }

    if (order.userId !== userId) {
      throw new customError("Unauthorized: Order does not belong to this user", 403);
    }

    if (order.status !== "draft") {
      // Already placed — a double-submitted/retried request. Idempotent
      // no-op rather than reserving stock a second time for the same order.
      return { success: true, order, alreadyProcessed: true };
    }

    // 2. Catch a stale draft before reserving anything for it. No money has
    // moved yet for COD, so a price/stock drift, a deleted delivery
    // address, or a delivery-charge/total that no longer matches the
    // current backend pricing rule (see order.service.js's
    // detectPricingConflict — e.g. an env-level delivery-charge config
    // change since the draft order was created or last refreshed) is still
    // safe to refuse outright — this is what stops a customer from being
    // charged a price/total that's since changed (or an order being
    // confirmed with nowhere to actually ship it), and gives a clear
    // "here's exactly what changed" 409 instead of a generic stock-shortfall
    // error, or a crash later in shipping.service.js, with no useful message.
    const conflicts = [
      ...(await orderService.detectAddressConflict(order.addressId, userId, tx, 'COD')),
      ...(await orderService.detectOrderConflicts(order.orderItems, tx)),
      ...orderService.detectPricingConflict(order),
    ];
    if (conflicts.length > 0) {
      throw new customError(
        'Some items in your order have changed since it was created. Please refresh your order before placing it.',
        409,
        { conflicts }
      );
    }

    // 3. Reserve stock before confirming. No money has moved yet for COD, so
    // unlike a paid order, we can simply refuse the order outright if stock
    // isn't there — the whole transaction (this decrement included) rolls
    // back on throw, so nothing is left half-applied. This is a final
    // atomic guard against a race the conflict check above can't fully
    // close on its own (another request consuming the same stock between
    // the check above and this decrement).
    await inventoryService.decrementStockForOrder(order.orderItems, tx);

    // 4. Update the order with COD details
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "cod_pending",
        status: "confirmed",
        payment_order_id:`cod-${orderId}`
      },
    });

    // Order is confirmed at this point (COD doesn't need a separate payment
    // step) — safe to clear the cart now. Queuing outside the transaction
    // would risk clearing it even if the transaction above rolled back; this
    // line only runs once that has committed successfully.
    await cartQueue.add('clear-cart', { userId });
    await notificationQueue.add('order-confirmation', { orderId: updatedOrder.id });

    return { success: true, order: updatedOrder, alreadyProcessed: false };
  });
};
