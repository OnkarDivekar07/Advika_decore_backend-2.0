const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = { userId: 'user_1', role: 'customer' };
    next();
  })
);

// Explicit factory (rather than automock) so requiring this test file never
// pulls in the real payment.service.js — and with it, real Razorpay/Redis/
// BullMQ client construction that would otherwise try to open connections.
jest.mock('@modules/payment/payment.service', () => ({
  verifyRazorpaySignature: jest.fn(),
  verifyWebhookSignature: jest.fn(),
  updateOrderAfterPayment: jest.fn(),
  handleRazorpayWebhookEvent: jest.fn(),
  handleCODOrder: jest.fn(),
  createRazorpayOrder: jest.fn(),
}));

jest.mock('@modules/order/order.service', () => ({
  detectOrderConflicts: jest.fn(),
  detectAddressConflict: jest.fn(),
}));

// findUnique backs the ownership check verifyPayment now does before
// trusting a signature-valid payment_order_id/payment_id pair (Razorpay
// order ids aren't secret, so /verify has to confirm the order it
// resolves to actually belongs to the caller — see payment.controller.js).
// Without a findUnique mock here, that lookup returns undefined and the
// controller throws trying to read `.userId` off it, 500ing every test
// that reaches this code path.
const mockDraftOrder = { findFirst: jest.fn(), findUnique: jest.fn() };
jest.mock('@config/prisma', () => ({ order: mockDraftOrder }));

const paymentService = require('@modules/payment/payment.service');
const orderService = require('@modules/order/order.service');
const paymentRoutes = require('@modules/payment/payment.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(responseMiddleware);
  app.use('/api/payment', paymentRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

describe('POST /api/payment/verify', () => {
  it('422s when required fields are missing', async () => {
    const res = await request(app).post('/api/payment/verify').send({});
    expect(res.status).toBe(422);
    expect(paymentService.verifyRazorpaySignature).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 400 and never touches the order', async () => {
    paymentService.verifyRazorpaySignature.mockReturnValue(false);

    const res = await request(app).post('/api/payment/verify').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'bad-signature',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid signature');
    expect(paymentService.updateOrderAfterPayment).not.toHaveBeenCalled();
  });

  it('confirms the order on a valid signature', async () => {
    paymentService.verifyRazorpaySignature.mockReturnValue(true);
    mockDraftOrder.findUnique.mockResolvedValue({ userId: 'user_1' });
    paymentService.updateOrderAfterPayment.mockResolvedValue({
      order: { id: 'order_1' },
      alreadyProcessed: false,
    });

    const res = await request(app).post('/api/payment/verify').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'good-signature',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment verified successfully');
    expect(res.body.data).toMatchObject({
      success: true,
      alreadyProcessed: false,
      orderId: 'order_1',
    });
  });

  it('404s when the order for this payment_order_id cannot be found', async () => {
    paymentService.verifyRazorpaySignature.mockReturnValue(true);
    mockDraftOrder.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/payment/verify').send({
      razorpay_order_id: 'order_missing',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'good-signature',
    });

    expect(res.status).toBe(404);
    expect(paymentService.updateOrderAfterPayment).not.toHaveBeenCalled();
  });

  it("403s when the order belongs to a different user (can't replay someone else's payment ids)", async () => {
    paymentService.verifyRazorpaySignature.mockReturnValue(true);
    mockDraftOrder.findUnique.mockResolvedValue({ userId: 'someone_else' });

    const res = await request(app).post('/api/payment/verify').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'good-signature',
    });

    expect(res.status).toBe(403);
    expect(paymentService.updateOrderAfterPayment).not.toHaveBeenCalled();
  });
});

describe('POST /api/payment/webhook', () => {
  it('400s when the signature header is missing', async () => {
    const res = await request(app)
      .post('/api/payment/webhook')
      .send({ event: 'payment.captured' });

    expect(res.status).toBe(400);
    expect(paymentService.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('400s on an invalid webhook signature', async () => {
    paymentService.verifyWebhookSignature.mockReturnValue(false);

    const res = await request(app)
      .post('/api/payment/webhook')
      .set('x-razorpay-signature', 'bad-sig')
      .send({ event: 'payment.captured' });

    expect(res.status).toBe(400);
    expect(paymentService.handleRazorpayWebhookEvent).not.toHaveBeenCalled();
  });

  it('acks with 200 and reconciles the order on a valid signature', async () => {
    paymentService.verifyWebhookSignature.mockReturnValue(true);
    paymentService.handleRazorpayWebhookEvent.mockResolvedValue();

    const payload = { event: 'payment.captured' };
    const res = await request(app)
      .post('/api/payment/webhook')
      .set('x-razorpay-signature', 'good-sig')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(paymentService.handleRazorpayWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.captured' })
    );
  });

  // The webhook route is registered before the `authenticate` middleware in
  // payment.routes.js (Razorpay calls it directly, with no user JWT) — this
  // guards against that ever regressing.
  it('does not require a user JWT', async () => {
    paymentService.verifyWebhookSignature.mockReturnValue(true);
    paymentService.handleRazorpayWebhookEvent.mockResolvedValue();

    const res = await request(app)
      .post('/api/payment/webhook')
      .set('x-razorpay-signature', 'good-sig')
      .send({ event: 'payment.captured' });

    expect(res.status).not.toBe(401);
  });
});

describe('POST /api/payment/cod', () => {
  it('422s when method is not "cod"', async () => {
    const res = await request(app)
      .post('/api/payment/cod')
      .send({ orderId: 'order_1', method: 'card' });

    expect(res.status).toBe(422);
    expect(paymentService.handleCODOrder).not.toHaveBeenCalled();
  });

  it('places the order for a valid COD request', async () => {
    paymentService.handleCODOrder.mockResolvedValue({
      success: true,
      order: { id: 'order_1' },
      alreadyProcessed: false,
    });

    const res = await request(app)
      .post('/api/payment/cod')
      .send({ orderId: 'order_1', method: 'cod' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('COD order placed successfully');
    expect(paymentService.handleCODOrder).toHaveBeenCalledWith(
      'order_1',
      'user_1'
    );
  });

  it('propagates a service error (e.g. unauthorized order) through the error handler', async () => {
    const CustomError = require('@utils/customError');
    paymentService.handleCODOrder.mockRejectedValue(
      new CustomError('Unauthorized: Order does not belong to this user', 403)
    );

    const res = await request(app)
      .post('/api/payment/cod')
      .send({ orderId: 'order_1', method: 'cod' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(
      'Unauthorized: Order does not belong to this user'
    );
  });
});

describe('POST /api/payment/create-orderid', () => {
  beforeEach(() => {
    mockDraftOrder.findFirst.mockReset();
    orderService.detectOrderConflicts.mockReset();
    orderService.detectAddressConflict.mockReset();
    // Default: no drift since the draft order was created, and the
    // delivery address is still around — matches the pre-existing fixtures
    // below, which weren't written with a price/stock/address conflict in
    // mind.
    orderService.detectOrderConflicts.mockResolvedValue([]);
    orderService.detectAddressConflict.mockResolvedValue([]);
  });

  it('401s when the user has no draft order', async () => {
    mockDraftOrder.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/payment/create-orderid').send();

    expect(res.status).toBe(401);
    expect(paymentService.createRazorpayOrder).not.toHaveBeenCalled();
  });

  it('creates a Razorpay order for a valid draft order', async () => {
    mockDraftOrder.findFirst.mockResolvedValue({
      id: 'order_1',
      total: 499,
      addressId: 'addr_1',
      orderItems: [{ productId: 'p1', quantity: 1, price: 499 }],
    });
    paymentService.createRazorpayOrder.mockResolvedValue({
      id: 'rzp_order_1',
    });

    const res = await request(app).post('/api/payment/create-orderid').send();

    expect(res.status).toBe(200);
    expect(res.body.data.order).toEqual({ id: 'rzp_order_1' });
    expect(res.body.data.key_id).toBe(process.env.RAZORPAY_KEY_ID);
    expect(orderService.detectAddressConflict).toHaveBeenCalledWith('addr_1', 'user_1');
    expect(orderService.detectOrderConflicts).toHaveBeenCalledWith([
      { productId: 'p1', quantity: 1, price: 499 },
    ]);
    expect(paymentService.createRazorpayOrder).toHaveBeenCalledWith({
      amount: 49900,
      currency: 'INR',
      receipt: 'order_order_1',
      order_id: 'order_1',
    });
  });

  // Price/stock conflict detection — see order.service.js's
  // detectOrderConflicts. A Razorpay order amount is fixed once created, so
  // this has to be checked before create-orderid ever calls Razorpay, not
  // after.
  it('409s with the structured conflicts and never creates a Razorpay order when the draft has drifted', async () => {
    mockDraftOrder.findFirst.mockResolvedValue({
      id: 'order_1',
      total: 499,
      orderItems: [{ productId: 'p1', quantity: 1, price: 499 }],
    });
    orderService.detectOrderConflicts.mockResolvedValue([
      {
        productId: 'p1',
        name: 'Running Shoe',
        type: 'price_changed',
        orderedPrice: 499,
        currentPrice: 599,
        message: 'The price of this item has changed since it was added to your order.',
      },
    ]);

    const res = await request(app).post('/api/payment/create-orderid').send();

    expect(res.status).toBe(409);
    expect(res.body.errors.conflicts).toEqual([
      expect.objectContaining({ productId: 'p1', type: 'price_changed' }),
    ]);
    expect(paymentService.createRazorpayOrder).not.toHaveBeenCalled();
  });

  // Address deletion — see order.service.js's detectAddressConflict. A
  // Razorpay order amount is fixed once created, so this has to be checked
  // before create-orderid ever calls Razorpay, same reasoning as the
  // price/stock conflict case above.
  it('409s with an address_unavailable conflict and never creates a Razorpay order when the delivery address has been deleted', async () => {
    mockDraftOrder.findFirst.mockResolvedValue({
      id: 'order_1',
      total: 499,
      addressId: 'addr_deleted',
      orderItems: [{ productId: 'p1', quantity: 1, price: 499 }],
    });
    orderService.detectAddressConflict.mockResolvedValue([
      {
        type: 'address_unavailable',
        message: 'The delivery address for this order is no longer available. Please choose a different address.',
      },
    ]);

    const res = await request(app).post('/api/payment/create-orderid').send();

    expect(res.status).toBe(409);
    expect(res.body.errors.conflicts).toEqual([
      expect.objectContaining({ type: 'address_unavailable' }),
    ]);
    expect(paymentService.createRazorpayOrder).not.toHaveBeenCalled();
  });
});
