const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function constantTimeEquals(a, b) {
  // Constant-time comparison so response timing can't leak how many
  // leading characters of a signature matched (defense-in-depth on a
  // payment-security code path) — used for both signature checks below.
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    raw: order,
  };
}

function normalizePayment(payment) {
  if (!payment) return null;
  return {
    id: payment.id,
    order_id: payment.order_id,
    status: payment.status,
    amount: payment.amount,
    raw: payment,
  };
}

function normalizeRefund(refund) {
  if (!refund) return null;
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    status: refund.status,
    amount: refund.amount,
    raw: refund,
  };
}

/**
 * Razorpay implementation of the payment gateway contract — see
 * ./paymentGateway.contract.js for what every adapter must provide and why.
 * This file (plus the `razorpay` package and RAZORPAY_* env vars it reads)
 * is deliberately the ONLY place in the payment module that should know
 * Razorpay's SDK, its request/response shapes, or its HMAC signature
 * scheme. payment.service.js and payment.controller.js never import
 * `razorpay` or build a signature themselves — they go through
 * ./index.js's exported instance of this contract instead.
 *
 * @type {import('./paymentGateway.contract').PaymentGateway}
 */
module.exports = {
  name: 'razorpay',

  // Handed straight through to the frontend by createOrderid (see
  // payment.controller.js) for Razorpay Checkout.js. Provider-specific by
  // nature — a different gateway's frontend integration would need its own
  // equivalent under whatever name it uses, but that's a frontend
  // integration concern, not something this module needs to generalize.
  publicConfig: {
    key_id: process.env.RAZORPAY_KEY_ID,
  },

  async createOrder({ amount, currency = 'INR', receipt }) {
    // Deliberately does NOT catch here — payment.service.js's
    // createRazorpayOrder wraps this together with the DB write that has
    // to follow it, and converts any failure from either step into the
    // same 500 CustomError.
    const order = await razorpay.orders.create({ amount, currency, receipt });
    return normalizeOrder(order);
  },

  async fetchOrder(orderId) {
    try {
      const order = await razorpay.orders.fetch(orderId);
      return normalizeOrder(order);
    } catch (err) {
      return null;
    }
  },

  async fetchOrderPayments(orderId) {
    try {
      const result = await razorpay.orders.fetchPayments(orderId);
      return (result?.items ?? []).map(normalizePayment);
    } catch (err) {
      return [];
    }
  },

  async fetchPayment(paymentId) {
    try {
      const payment = await razorpay.payments.fetch(paymentId);
      return normalizePayment(payment);
    } catch (err) {
      return null;
    }
  },

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + '|' + paymentId)
      .digest('hex');

    return constantTimeEquals(generatedSignature, signature);
  },

  verifyWebhookSignature(rawBody, signature) {
    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody) // Buffer of the exact bytes Razorpay sent — do not use a re-stringified body
      .digest('hex');

    return constantTimeEquals(generatedSignature, signature);
  },

  parseWebhookEvent(body) {
    const eventType = body?.event ?? null;
    const payment = normalizePayment(body?.payload?.payment?.entity);
    // Refund-lifecycle events (refund.created/processed/failed) carry the
    // refund entity under payload.refund, not payload.payment — a
    // completely separate branch of Razorpay's webhook payload shape, not
    // a field on the payment entity.
    const refund = normalizeRefund(body?.payload?.refund?.entity);
    return { eventType, payment, refund };
  },

  /**
   * Initiates a refund against a captured payment. Omitting `amount`
   * refunds the payment's full captured amount — this app never does a
   * partial refund (see the contract's own doc comment on refundPayment).
   * Deliberately does NOT catch here, same pattern as createOrder above —
   * payment.service.js's refundOrderPayment wraps this together with the
   * order-status write that has to follow it.
   */
  async refundPayment({ paymentId, amount, notes }) {
    const refund = await razorpay.payments.refund(paymentId, {
      ...(amount != null ? { amount } : {}),
      ...(notes ? { notes } : {}),
    });
    return normalizeRefund(refund);
  },

  async fetchRefund(paymentId, refundId) {
    try {
      const refund = await razorpay.payments.fetchRefund(paymentId, refundId);
      return normalizeRefund(refund);
    } catch (err) {
      return null;
    }
  },

  async fetchRefundsForPayment(paymentId) {
    try {
      const result = await razorpay.payments.fetchMultipleRefund(paymentId);
      return (result?.items ?? []).map(normalizeRefund);
    } catch (err) {
      return [];
    }
  },
};
