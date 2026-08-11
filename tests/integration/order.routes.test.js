const express = require('express');
const request = require('supertest');

// Authenticate is mocked to read the user id/role off headers so a single
// test file can exercise both the customer-facing and admin-only routes.
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
// pulls in the real order.service.js / a real Prisma client.
jest.mock('@modules/order/order.service', () => ({
  createDraftOrderService: jest.fn(),
  getUserDraftOrder: jest.fn(),
  getAllOrders: jest.fn(),
  fetchOrderById: jest.fn(),
}));

const mockAddress = { findUnique: jest.fn() };
jest.mock('@config/prisma', () => ({ address: mockAddress }));

const orderService = require('@modules/order/order.service');
const orderRoutes = require('@modules/order/order.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');
const CustomError = require('@utils/customError');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/order', orderRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const VALID_ADDRESS_ID = '507f1f77bcf86cd799439011';
const VALID_ORDER_ID = '507f1f77bcf86cd799439099';

beforeEach(() => {
  Object.values(orderService).forEach((fn) => fn.mockReset());
  mockAddress.findUnique.mockReset();
});

describe('POST /api/order', () => {
  it('422s when selectedAddressId is missing', async () => {
    const res = await request(app).post('/api/order').send({});

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('422s when selectedAddressId is not a valid ObjectId', async () => {
    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: 'not-an-object-id' });

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('403s when the address does not exist', async () => {
    mockAddress.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Invalid address selection');
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('403s when the address belongs to a different user', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'someone_else',
    });

    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID });

    expect(res.status).toBe(403);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('creates/updates the draft order for a valid, owned address', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'user_1',
    });
    orderService.createDraftOrderService.mockResolvedValue({
      id: VALID_ORDER_ID,
      status: 'draft',
      total: 999,
    });

    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe(
      'Draft order created/updated successfully.'
    );
    expect(orderService.createDraftOrderService).toHaveBeenCalledWith(
      'user_1',
      VALID_ADDRESS_ID,
      null,
      null
    );
    expect(res.body.data).toEqual({
      id: VALID_ORDER_ID,
      status: 'draft',
      total: 999,
    });
  });

  it('propagates a service error (e.g. empty cart) through the error handler', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'user_1',
    });
    orderService.createDraftOrderService.mockRejectedValue(
      new CustomError('No items found in cart', 404)
    );

    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No items found in cart');
  });

  // Discount/coupon placeholder architecture — see order.service.js /
  // src/constants/pricing.js. Only shape-validated at this layer; a code
  // that's the wrong *type* here should never even reach the service.
  it('passes an optional couponCode through to the service unchanged', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'user_1',
    });
    orderService.createDraftOrderService.mockResolvedValue({
      id: VALID_ORDER_ID,
      status: 'draft',
      total: 999,
    });

    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID, couponCode: 'SAVE10' });

    expect(res.status).toBe(201);
    expect(orderService.createDraftOrderService).toHaveBeenCalledWith(
      'user_1',
      VALID_ADDRESS_ID,
      'SAVE10',
      null
    );
  });

  it('422s when couponCode is not a string', async () => {
    const res = await request(app)
      .post('/api/order')
      .send({ selectedAddressId: VALID_ADDRESS_ID, couponCode: 12345 });

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  // Buy Now — see checkout-architecture.md §3.2 step 5 / §4.4. Shape is
  // validated here; the actual product/stock re-check happens server-side
  // in order.service.js, exercised separately in order.service.test.js.
  const VALID_PRODUCT_ID = '507f1f77bcf86cd799439022';

  it('passes an optional buyNow line item through to the service unchanged', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'user_1',
    });
    orderService.createDraftOrderService.mockResolvedValue({
      id: VALID_ORDER_ID,
      status: 'draft',
      total: 1999,
    });

    const res = await request(app).post('/api/order').send({
      selectedAddressId: VALID_ADDRESS_ID,
      buyNow: { productId: VALID_PRODUCT_ID, quantity: 2 },
    });

    expect(res.status).toBe(201);
    expect(orderService.createDraftOrderService).toHaveBeenCalledWith(
      'user_1',
      VALID_ADDRESS_ID,
      null,
      { productId: VALID_PRODUCT_ID, quantity: 2 }
    );
  });

  it('422s when buyNow.productId is not a valid ObjectId', async () => {
    const res = await request(app).post('/api/order').send({
      selectedAddressId: VALID_ADDRESS_ID,
      buyNow: { productId: 'not-an-object-id', quantity: 1 },
    });

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('422s when buyNow.quantity is not a positive integer', async () => {
    const res = await request(app).post('/api/order').send({
      selectedAddressId: VALID_ADDRESS_ID,
      buyNow: { productId: VALID_PRODUCT_ID, quantity: 0 },
    });

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });
});

describe('GET /api/order', () => {
  it('404s when the user has no draft order', async () => {
    orderService.getUserDraftOrder.mockResolvedValue(null);

    const res = await request(app).get('/api/order');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No draft order found.');
  });

  it("200s with the user's draft order", async () => {
    orderService.getUserDraftOrder.mockResolvedValue({
      id: VALID_ORDER_ID,
      userId: 'user_1',
      status: 'draft',
      total: 500,
    });

    const res = await request(app).get('/api/order');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Draft order fetched successfully');
    expect(orderService.getUserDraftOrder).toHaveBeenCalledWith('user_1');
    expect(res.body.data.id).toBe(VALID_ORDER_ID);
  });
});

describe('GET /api/order/all', () => {
  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .get('/api/order/all')
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
    expect(orderService.getAllOrders).not.toHaveBeenCalled();
  });

  it('200s with the full order list for an admin', async () => {
    orderService.getAllOrders.mockResolvedValue([
      { id: VALID_ORDER_ID, total: 500, status: 'confirmed' },
    ]);

    const res = await request(app)
      .get('/api/order/all')
      .set('x-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('All orders fetched successfully');
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /api/order/:id', () => {
  it('422s when the id is not a valid ObjectId', async () => {
    const res = await request(app)
      .get('/api/order/not-an-object-id')
      .set('x-role', 'customer');

    expect(res.status).toBe(422);
    expect(orderService.fetchOrderById).not.toHaveBeenCalled();
  });

  it('404s when the order does not exist', async () => {
    orderService.fetchOrderById.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/order/${VALID_ORDER_ID}`)
      .set('x-role', 'customer');

    expect(res.status).toBe(404);
  });

  it('200s with the order for the owning customer', async () => {
    orderService.fetchOrderById.mockResolvedValue({
      id: VALID_ORDER_ID,
      userId: 'user_1',
      total: 500,
    });

    const res = await request(app)
      .get(`/api/order/${VALID_ORDER_ID}`)
      .set('x-user-id', 'user_1')
      .set('x-role', 'customer');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order fetched successfully');
    expect(orderService.fetchOrderById).toHaveBeenCalledWith(VALID_ORDER_ID);
  });

  it("403s when a customer requests another user's order", async () => {
    orderService.fetchOrderById.mockResolvedValue({
      id: VALID_ORDER_ID,
      userId: 'someone_else',
      total: 500,
    });

    const res = await request(app)
      .get(`/api/order/${VALID_ORDER_ID}`)
      .set('x-user-id', 'user_1')
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
  });

  it('200s with the order for an admin regardless of owner', async () => {
    orderService.fetchOrderById.mockResolvedValue({
      id: VALID_ORDER_ID,
      userId: 'someone_else',
      total: 500,
    });

    const res = await request(app)
      .get(`/api/order/${VALID_ORDER_ID}`)
      .set('x-user-id', 'admin_1')
      .set('x-role', 'admin');

    expect(res.status).toBe(200);
    expect(orderService.fetchOrderById).toHaveBeenCalledWith(VALID_ORDER_ID);
  });
});
