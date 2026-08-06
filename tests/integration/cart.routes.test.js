const express = require('express');
const request = require('supertest');

jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = { userId: 'user_1', role: 'customer' };
    next();
  })
);

// Explicit factory (rather than automock) so requiring this test file never
// pulls in a real Prisma client / DB connection — cart.service talks to
// prisma directly, so we double the exact methods it calls.
const mockCart = {
  findMany: jest.fn(),
  deleteMany: jest.fn(),
  createMany: jest.fn(),
  updateMany: jest.fn(),
};
jest.mock('@config/prisma', () => ({ cart: mockCart }));

const cartRoutes = require('@modules/cart/cart.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/cart', cartRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

beforeEach(() => {
  Object.values(mockCart).forEach((fn) => fn.mockReset());
});

describe('GET /api/cart', () => {
  it('returns the logged-in user\'s cart, joined with product data', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: { id: 'prod_1', name: 'Running Shoe', price: 1999 },
      },
    ]);

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Cart fetched successfully');
    expect(mockCart.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      include: { product: true },
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].product.name).toBe('Running Shoe');
  });

  it('returns an empty array when the cart has no items', async () => {
    mockCart.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('propagates a database error through the error handler', async () => {
    mockCart.findMany.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/cart', () => {
  it('422s when cartItems is missing', async () => {
    const res = await request(app).post('/api/cart').send({});

    expect(res.status).toBe(422);
    expect(mockCart.deleteMany).not.toHaveBeenCalled();
  });

  it('422s when cartItems is not an array', async () => {
    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: 'not-an-array' });

    expect(res.status).toBe(422);
    expect(mockCart.createMany).not.toHaveBeenCalled();
  });

  it('422s when cartItems is an empty array', async () => {
    const res = await request(app).post('/api/cart').send({ cartItems: [] });

    expect(res.status).toBe(422);
  });

  it('422s when an item has an invalid quantity', async () => {
    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 0 }] });

    expect(res.status).toBe(422);
    expect(mockCart.createMany).not.toHaveBeenCalled();
  });

  it('422s when an item is missing a productId', async () => {
    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ quantity: 2 }] });

    expect(res.status).toBe(422);
  });

  it('replaces the existing cart with the submitted items on a valid payload', async () => {
    mockCart.deleteMany.mockResolvedValue({ count: 1 });
    mockCart.createMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .post('/api/cart')
      .send({
        cartItems: [
          { productId: 'prod_1', quantity: 2 },
          { productId: 'prod_2', quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Cart saved successfully');

    // Old cart is cleared first...
    expect(mockCart.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
    });
    // ...then replaced wholesale with the new items.
    expect(mockCart.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user_1', productId: 'prod_1', quantity: 2 },
        { userId: 'user_1', productId: 'prod_2', quantity: 1 },
      ],
    });
  });

  it('propagates a database error through the error handler', async () => {
    mockCart.deleteMany.mockResolvedValue({ count: 0 });
    mockCart.createMany.mockRejectedValue(new Error('write failed'));

    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 1 }] });

    expect(res.status).toBe(500);
  });
});
