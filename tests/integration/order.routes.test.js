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
  getUserOrderHistory: jest.fn(),
  getAllOrders: jest.fn(),
  fetchOrderById: jest.fn(),
  cancelOrderByCustomer: jest.fn(),
}));

// order.controller.js's refundOrder handler pulls in payment.service.js —
// mocked here for the same reason payment.routes.test.js mocks it: requiring
// the real module would construct real Razorpay/Redis/BullMQ clients.
jest.mock('@modules/payment/payment.service', () => ({
  refundOrderPayment: jest.fn(),
}));

const mockAddress = { findUnique: jest.fn() };
jest.mock('@config/prisma', () => ({ address: mockAddress }));

const orderService = require('@modules/order/order.service');
const paymentService = require('@modules/payment/payment.service');
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
  Object.values(paymentService).forEach((fn) => fn.mockReset());
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
    expect(res.body.message).toBe('Draft order created/updated successfully.');
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

  // Regression coverage for one specific invariant: the client can never
  // influence the delivery charge or order total — those are always
  // derived server-side from live cart/product data (see
  // order.service.js's createDraftOrderService / calculateDeliveryCharge).
  // validateDraftOrder only whitelists selectedAddressId/couponCode/buyNow
  // (see order.validation.js), and the controller only ever destructures
  // those same three fields off req.body — this proves a hostile pricing
  // field tacked onto an otherwise-valid request neither reaches the
  // service call nor leaks into the response.
  it('ignores a client-supplied deliveryCharge/subtotal/total/discount — the service call and response are unaffected', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: VALID_ADDRESS_ID,
      userId: 'user_1',
    });
    // What the service actually (and only) returns — deliberately
    // different from every hostile value in the request below, so this
    // test fails loudly if a tampered value leaks through anywhere.
    const serverComputedOrder = {
      id: VALID_ORDER_ID,
      status: 'draft',
      total: 2048,
      subtotal: 1999,
      deliveryCharge: 49,
      discount: 0,
    };
    orderService.createDraftOrderService.mockResolvedValue(serverComputedOrder);

    const res = await request(app).post('/api/order').send({
      selectedAddressId: VALID_ADDRESS_ID,
      // Hostile extras — not in validateDraftOrder's whitelist, so
      // express-validator never inspects them and the controller never
      // destructures them.
      deliveryCharge: 0,
      shippingCharge: 0,
      subtotal: 1,
      total: 1,
      discount: 9999,
    });

    expect(res.status).toBe(201);
    // Called with exactly the four positional args the controller passes —
    // no fifth "pricing overrides" object, no spread of req.body.
    expect(orderService.createDraftOrderService).toHaveBeenCalledWith(
      'user_1',
      VALID_ADDRESS_ID,
      null,
      null
    );
    // The response reflects only what the service (server-side pricing)
    // returned — the hostile total: 1 / discount: 9999 never show up.
    expect(res.body.data).toEqual(serverComputedOrder);
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

    const res = await request(app)
      .post('/api/order')
      .send({
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
    const res = await request(app)
      .post('/api/order')
      .send({
        selectedAddressId: VALID_ADDRESS_ID,
        buyNow: { productId: 'not-an-object-id', quantity: 1 },
      });

    expect(res.status).toBe(422);
    expect(orderService.createDraftOrderService).not.toHaveBeenCalled();
  });

  it('422s when buyNow.quantity is not a positive integer', async () => {
    const res = await request(app)
      .post('/api/order')
      .send({
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

describe('GET /api/order/history', () => {
  it('200s with the paginated order history for the logged-in user only', async () => {
    orderService.getUserOrderHistory.mockResolvedValue({
      orders: [{ id: VALID_ORDER_ID, total: 500, status: 'confirmed' }],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    const res = await request(app)
      .get('/api/order/history')
      .set('x-user-id', 'user_1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order history fetched successfully');
    expect(orderService.getUserOrderHistory).toHaveBeenCalledWith('user_1', {
      page: undefined,
      limit: undefined,
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });
  });

  it('passes page/limit query params through to the service', async () => {
    orderService.getUserOrderHistory.mockResolvedValue({
      orders: [],
      meta: { total: 0, page: 2, limit: 5, totalPages: 0 },
    });

    const res = await request(app)
      .get('/api/order/history?page=2&limit=5')
      .set('x-user-id', 'user_1');

    expect(res.status).toBe(200);
    // Express 5 makes req.query a read-only getter, so express-validator's
    // .toInt() sanitizer (still useful for its *validation* pass) can't
    // mutate it in place here — page/limit arrive at the controller as the
    // raw query strings. That's fine: getUserOrderHistory itself
    // defensively parseInt()s whatever it's given (see
    // order.service.js), so this is still safe end-to-end even though the
    // controller passes strings through rather than already-coerced
    // numbers.
    expect(orderService.getUserOrderHistory).toHaveBeenCalledWith('user_1', {
      page: '2',
      limit: '5',
    });
  });

  it('422s when page is not a positive integer', async () => {
    const res = await request(app).get('/api/order/history?page=0');

    expect(res.status).toBe(422);
    expect(orderService.getUserOrderHistory).not.toHaveBeenCalled();
  });

  it('422s when limit exceeds the max of 50', async () => {
    const res = await request(app).get('/api/order/history?limit=51');

    expect(res.status).toBe(422);
    expect(orderService.getUserOrderHistory).not.toHaveBeenCalled();
  });

  it('never matches getOrderById (the literal "history" segment wins over :id)', async () => {
    orderService.getUserOrderHistory.mockResolvedValue({
      orders: [],
      meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
    });

    await request(app).get('/api/order/history');

    expect(orderService.fetchOrderById).not.toHaveBeenCalled();
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

  it('200s with the paginated order list for an admin', async () => {
    orderService.getAllOrders.mockResolvedValue({
      orders: [
        {
          id: VALID_ORDER_ID,
          total: 500,
          status: 'confirmed',
          paymentStatus: 'paid',
        },
      ],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });

    const res = await request(app).get('/api/order/all').set('x-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('All orders fetched successfully');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual(
      expect.objectContaining({ total: 1, page: 1, limit: 20, totalPages: 1 })
    );
  });

  it('passes page/limit/status/paymentStatus/dateFrom/dateTo/search through to the service', async () => {
    orderService.getAllOrders.mockResolvedValue({
      orders: [],
      meta: { total: 0, page: 2, limit: 5, totalPages: 0 },
    });

    const res = await request(app)
      .get('/api/order/all')
      .query({
        page: 2,
        limit: 5,
        status: 'shipped',
        paymentStatus: 'paid',
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
        search: 'jane',
      })
      .set('x-role', 'admin');

    expect(res.status).toBe(200);
    // Express 5 makes req.query a read-only getter, so express-validator's
    // .toInt()/.toDate() sanitizers (still useful for their *validation*
    // pass) can't mutate it in place — page/limit/dateFrom/dateTo arrive
    // at the controller as raw query strings, same as GET /api/order/history
    // (see that describe block above). getAllOrders itself defensively
    // parses/re-validates whatever it's given (see order.service.js), so
    // this is still safe end-to-end.
    expect(orderService.getAllOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        page: '2',
        limit: '5',
        status: 'shipped',
        paymentStatus: 'paid',
        search: 'jane',
      })
    );
  });

  it('422s for an invalid status filter', async () => {
    const res = await request(app)
      .get('/api/order/all')
      .query({ status: 'draft' })
      .set('x-role', 'admin');

    expect(res.status).toBe(422);
    expect(orderService.getAllOrders).not.toHaveBeenCalled();
  });

  it('422s for an invalid paymentStatus filter', async () => {
    const res = await request(app)
      .get('/api/order/all')
      .query({ paymentStatus: 'not-a-real-status' })
      .set('x-role', 'admin');

    expect(res.status).toBe(422);
    expect(orderService.getAllOrders).not.toHaveBeenCalled();
  });

  it('422s for a limit above the max', async () => {
    const res = await request(app)
      .get('/api/order/all')
      .query({ limit: 500 })
      .set('x-role', 'admin');

    expect(res.status).toBe(422);
    expect(orderService.getAllOrders).not.toHaveBeenCalled();
  });

  it('422s for a malformed dateFrom', async () => {
    const res = await request(app)
      .get('/api/order/all')
      .query({ dateFrom: 'not-a-date' })
      .set('x-role', 'admin');

    expect(res.status).toBe(422);
    expect(orderService.getAllOrders).not.toHaveBeenCalled();
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

describe('POST /api/order/:id/cancel', () => {
  it('422s when the id is not a valid ObjectId', async () => {
    const res = await request(app)
      .post('/api/order/not-an-object-id/cancel')
      .set('x-role', 'customer');

    expect(res.status).toBe(422);
    expect(orderService.cancelOrderByCustomer).not.toHaveBeenCalled();
  });

  it('422s when reason exceeds the length cap', async () => {
    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/cancel`)
      .set('x-role', 'customer')
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(422);
    expect(orderService.cancelOrderByCustomer).not.toHaveBeenCalled();
  });

  it('200s and calls the service with the requesting user id and reason', async () => {
    orderService.cancelOrderByCustomer.mockResolvedValue({
      id: VALID_ORDER_ID,
      status: 'cancelled',
    });

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/cancel`)
      .set('x-user-id', 'user_1')
      .set('x-role', 'customer')
      .send({ reason: 'Changed my mind' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order cancelled successfully');
    expect(res.body.data.status).toBe('cancelled');
    expect(orderService.cancelOrderByCustomer).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      'user_1',
      'Changed my mind'
    );
  });

  it('works with no reason provided at all', async () => {
    orderService.cancelOrderByCustomer.mockResolvedValue({
      id: VALID_ORDER_ID,
      status: 'cancelled',
    });

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/cancel`)
      .set('x-user-id', 'user_1')
      .set('x-role', 'customer')
      .send({});

    expect(res.status).toBe(200);
    expect(orderService.cancelOrderByCustomer).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      'user_1',
      undefined
    );
  });

  it('propagates a 403 from the service when the requester does not own the order', async () => {
    orderService.cancelOrderByCustomer.mockRejectedValue(
      new CustomError('Not authorized to cancel this order', 403)
    );

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/cancel`)
      .set('x-role', 'customer')
      .send({});

    expect(res.status).toBe(403);
  });

  it('propagates a 400 (contact support) from the service for a paid-online order', async () => {
    orderService.cancelOrderByCustomer.mockRejectedValue(
      new CustomError(
        'This order was already paid online — please contact support to cancel it and arrange a refund.',
        400
      )
    );

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/cancel`)
      .set('x-role', 'customer')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/contact support/i);
  });
});

describe('POST /api/order/:id/refund', () => {
  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-role', 'customer')
      .send({});

    expect(res.status).toBe(403);
    expect(paymentService.refundOrderPayment).not.toHaveBeenCalled();
  });

  it('422s when the id is not a valid ObjectId', async () => {
    const res = await request(app)
      .post('/api/order/not-an-object-id/refund')
      .set('x-role', 'admin')
      .send({});

    expect(res.status).toBe(422);
    expect(paymentService.refundOrderPayment).not.toHaveBeenCalled();
  });

  it('422s when reason exceeds the length cap', async () => {
    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-role', 'admin')
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(422);
    expect(paymentService.refundOrderPayment).not.toHaveBeenCalled();
  });

  it('200s and calls refundOrderPayment with the order id, admin user id and reason', async () => {
    paymentService.refundOrderPayment.mockResolvedValue({
      order: { id: VALID_ORDER_ID, paymentStatus: 'refund_pending' },
      refund: { id: 'rfnd_1' },
    });

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-user-id', 'admin_1')
      .set('x-role', 'admin')
      .send({ reason: 'Customer requested cancellation' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Refund initiated successfully');
    expect(res.body.data.order.paymentStatus).toBe('refund_pending');
    expect(paymentService.refundOrderPayment).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      'admin_1',
      'Customer requested cancellation'
    );
  });

  it('works with no reason provided at all', async () => {
    paymentService.refundOrderPayment.mockResolvedValue({
      order: { id: VALID_ORDER_ID, paymentStatus: 'refund_pending' },
      refund: { id: 'rfnd_1' },
    });

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-user-id', 'admin_1')
      .set('x-role', 'admin')
      .send({});

    expect(res.status).toBe(200);
    expect(paymentService.refundOrderPayment).toHaveBeenCalledWith(
      VALID_ORDER_ID,
      'admin_1',
      undefined
    );
  });

  it('propagates a 400 from the service for an order that is not paid', async () => {
    paymentService.refundOrderPayment.mockRejectedValue(
      new CustomError(
        "Cannot refund an order with payment status 'pending' — only a fully paid order can be refunded this way.",
        400
      )
    );

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-role', 'admin')
      .send({});

    expect(res.status).toBe(400);
  });

  it('propagates a 404 from the service for an order that does not exist', async () => {
    paymentService.refundOrderPayment.mockRejectedValue(
      new CustomError('Order not found', 404)
    );

    const res = await request(app)
      .post(`/api/order/${VALID_ORDER_ID}/refund`)
      .set('x-role', 'admin')
      .send({});

    expect(res.status).toBe(404);
  });
});
