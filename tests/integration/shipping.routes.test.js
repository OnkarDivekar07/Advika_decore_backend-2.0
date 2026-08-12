const express = require('express');
const request = require('supertest');

// Authenticate is mocked to read the user id/role off headers, so a single
// test file can exercise both the owner/admin-success and 403 paths — same
// pattern as inventory.routes.test.js. authorizeAdminOnly is left real,
// since it's simple logic that just reads req.user.role.
jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = {
      userId: req.headers['x-user-id'] || 'user_1',
      role: req.headers['x-role'] || 'customer',
    };
    next();
  })
);

// Explicit factory (rather than automock) so requiring this test file never
// pulls in the real shipping.service.js / a real Prisma client.
jest.mock('@modules/shipping/shipping.service', () => ({
  getDeliveryConfig: jest.fn(),
  checkServiceability: jest.fn(),
  createShipmentForOrder: jest.fn(),
  trackOrderShipment: jest.fn(),
  cancelOrderShipment: jest.fn(),
  handleEkartWebhookEvent: jest.fn(),
}));

// The webhook route verifies the signature via the Ekart client directly
// (mirroring how payment.controller.js calls paymentService for Razorpay's
// signature check) — mocked the same way as in shipping.service.test.js.
jest.mock('../../src/services/external/EkartClient', () => ({
  verifyWebhookSignature: jest.fn(),
}));

const shippingService = require('@modules/shipping/shipping.service');
const ekartClient = require('../../src/services/external/EkartClient');
const shippingRoutes = require('@modules/shipping/shipping.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');
const CustomError = require('@utils/customError');

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
  app.use('/api/shipping', shippingRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();
const VALID_ORDER_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  Object.values(shippingService).forEach((fn) => fn.mockReset());
  ekartClient.verifyWebhookSignature.mockReset();
});

describe('GET /api/shipping/delivery-config', () => {
  it('returns the configured delivery pricing rule without requiring a user JWT', async () => {
    shippingService.getDeliveryConfig.mockReturnValue({
      freeDeliveryThreshold: 600,
      deliveryCharge: 49,
    });

    const res = await request(app).get('/api/shipping/delivery-config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ freeDeliveryThreshold: 600, deliveryCharge: 49 });
  });
});

describe('POST /api/shipping/serviceability', () => {
  it('422s on an invalid pincode', async () => {
    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: 'not-a-pincode' });

    expect(res.status).toBe(422);
    expect(shippingService.checkServiceability).not.toHaveBeenCalled();
  });

  it('does not require a user JWT', async () => {
    shippingService.checkServiceability.mockResolvedValue({
      serviceable: true,
      estimatedDays: 3,
      codAvailable: true,
    });

    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: '400001' });

    expect(res.status).toBe(200);
  });

  it('422s a leading-zero pincode (well-formed 6 digits, but not a real Indian pincode shape)', async () => {
    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: '012345' });

    expect(res.status).toBe(422);
    expect(shippingService.checkServiceability).not.toHaveBeenCalled();
  });

  it('422s an empty pincode', async () => {
    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: '' });

    expect(res.status).toBe(422);
    expect(shippingService.checkServiceability).not.toHaveBeenCalled();
  });

  it('passes an optional subtotal through to the service so pricing can be folded into the response', async () => {
    shippingService.checkServiceability.mockResolvedValue({
      serviceable: true,
      estimatedDays: 3,
      codAvailable: true,
      deliveryCharge: 0,
      freeDeliveryThreshold: 600,
      freeDeliveryEligible: true,
    });

    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: '400001', subtotal: 799 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deliveryCharge: 0, freeDeliveryEligible: true });
    expect(shippingService.checkServiceability).toHaveBeenCalledWith({
      destinationPincode: '400001',
      paymentMode: undefined,
      weightKg: undefined,
      subtotal: 799,
    });
  });

  it('returns the serviceability result for a valid pincode', async () => {
    shippingService.checkServiceability.mockResolvedValue({
      serviceable: true,
      estimatedDays: 3,
      codAvailable: true,
    });

    const res = await request(app)
      .post('/api/shipping/serviceability')
      .send({ pincode: '400001', paymentMode: 'COD' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      serviceable: true,
      estimatedDays: 3,
      codAvailable: true,
    });
    expect(shippingService.checkServiceability).toHaveBeenCalledWith({
      destinationPincode: '400001',
      paymentMode: 'COD',
      weightKg: undefined,
    });
  });
});

describe('POST /api/shipping/:orderId/create', () => {
  it('403s a non-admin', async () => {
    const res = await request(app)
      .post(`/api/shipping/${VALID_ORDER_ID}/create`)
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
    expect(shippingService.createShipmentForOrder).not.toHaveBeenCalled();
  });

  it('422s an invalid orderId', async () => {
    const res = await request(app)
      .post('/api/shipping/not-an-object-id/create')
      .set('x-role', 'admin');

    expect(res.status).toBe(422);
  });

  it('creates a shipment for an admin', async () => {
    shippingService.createShipmentForOrder.mockResolvedValue({
      shipment: { id: 'shipment_1', orderId: VALID_ORDER_ID },
      alreadyProcessed: false,
    });

    const res = await request(app)
      .post(`/api/shipping/${VALID_ORDER_ID}/create`)
      .set('x-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Shipment created successfully');
    expect(shippingService.createShipmentForOrder).toHaveBeenCalledWith(VALID_ORDER_ID);
  });

  it("reports 'already created' without treating it as an error", async () => {
    shippingService.createShipmentForOrder.mockResolvedValue({
      shipment: { id: 'shipment_1' },
      alreadyProcessed: true,
    });

    const res = await request(app)
      .post(`/api/shipping/${VALID_ORDER_ID}/create`)
      .set('x-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Shipment already created for this order');
  });

  it('propagates a service error (e.g. unconfirmed order) through the error handler', async () => {
    shippingService.createShipmentForOrder.mockRejectedValue(
      new CustomError("Cannot ship an order with status 'draft'", 400)
    );

    const res = await request(app)
      .post(`/api/shipping/${VALID_ORDER_ID}/create`)
      .set('x-role', 'admin');

    expect(res.status).toBe(400);
  });
});

describe('GET /api/shipping/:orderId/track', () => {
  it('fetches the shipment status for the authenticated user', async () => {
    shippingService.trackOrderShipment.mockResolvedValue({
      orderId: VALID_ORDER_ID,
      status: 'IN_TRANSIT',
    });

    const res = await request(app)
      .get(`/api/shipping/${VALID_ORDER_ID}/track`)
      .set('x-user-id', 'user_1');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('IN_TRANSIT');
    expect(shippingService.trackOrderShipment).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      expect.objectContaining({ userId: 'user_1' })
    );
  });

  it("never leaks Ekart's raw payload out through the API — only the normalized shipment fields", async () => {
    shippingService.trackOrderShipment.mockResolvedValue({
      orderId: VALID_ORDER_ID,
      status: 'IN_TRANSIT',
      trackingId: 'EKT123',
      raw: { some_ekart_internal_field: 'should-not-leak', is_serviceable: true },
    });

    const res = await request(app)
      .get(`/api/shipping/${VALID_ORDER_ID}/track`)
      .set('x-user-id', 'user_1');

    expect(res.status).toBe(200);
    expect(res.body.data.trackingId).toBe('EKT123');
    expect(res.body.data).not.toHaveProperty('raw');
  });

  it("propagates a 403 from the service when it's not the owner", async () => {
    shippingService.trackOrderShipment.mockRejectedValue(
      new CustomError('Not authorized to view this shipment', 403)
    );

    const res = await request(app).get(`/api/shipping/${VALID_ORDER_ID}/track`);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/shipping/:orderId/cancel', () => {
  it('cancels the shipment for the authenticated user', async () => {
    shippingService.cancelOrderShipment.mockResolvedValue({
      orderId: VALID_ORDER_ID,
      status: 'CANCELLED',
    });

    const res = await request(app)
      .post(`/api/shipping/${VALID_ORDER_ID}/cancel`)
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Shipment cancelled successfully');
    expect(shippingService.cancelOrderShipment).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      expect.objectContaining({ userId: 'user_1' }),
      'Changed my mind'
    );
  });

  it('propagates a 400 when the shipment is already in a terminal state', async () => {
    shippingService.cancelOrderShipment.mockRejectedValue(
      new CustomError("Cannot cancel a shipment that is already 'DELIVERED'", 400)
    );

    const res = await request(app).post(`/api/shipping/${VALID_ORDER_ID}/cancel`).send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/shipping/webhook', () => {
  it('400s on an invalid webhook signature', async () => {
    ekartClient.verifyWebhookSignature.mockReturnValue(false);

    const res = await request(app)
      .post('/api/shipping/webhook')
      .set('x-ekart-signature', 'bad-sig')
      .send({ tracking_id: 'EKT123', status: 'DELIVERED' });

    expect(res.status).toBe(400);
    expect(shippingService.handleEkartWebhookEvent).not.toHaveBeenCalled();
  });

  it('acks with 200 and reconciles the shipment on a valid signature', async () => {
    ekartClient.verifyWebhookSignature.mockReturnValue(true);
    shippingService.handleEkartWebhookEvent.mockResolvedValue();

    const res = await request(app)
      .post('/api/shipping/webhook')
      .set('x-ekart-signature', 'good-sig')
      .send({ tracking_id: 'EKT123', status: 'DELIVERED' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(shippingService.handleEkartWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tracking_id: 'EKT123' })
    );
  });

  // The webhook route is registered before the `authenticate` middleware in
  // shipping.routes.js (Ekart calls it directly, with no user JWT) — this
  // guards against that ever regressing.
  it('does not require a user JWT', async () => {
    ekartClient.verifyWebhookSignature.mockReturnValue(true);
    shippingService.handleEkartWebhookEvent.mockResolvedValue();

    const res = await request(app)
      .post('/api/shipping/webhook')
      .send({ tracking_id: 'EKT123', status: 'DELIVERED' });

    expect(res.status).not.toBe(401);
  });
});
