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
  upsert: jest.fn(),
};
const mockProduct = {
  findUnique: jest.fn(),
};
jest.mock('@config/prisma', () => ({
  cart: mockCart,
  product: mockProduct,
  // Interactive-transaction style, matching how cart.service (and the
  // rest of the codebase, e.g. order.service) actually calls $transaction.
  $transaction: jest.fn((cb) => cb({ cart: mockCart, product: mockProduct })),
}));

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

const inStockProduct = (overrides = {}) => ({
  id: 'prod_1',
  name: 'Running Shoe',
  price: 1999,
  stock: 10,
  isDeleted: false,
  ...overrides,
});

beforeEach(() => {
  Object.values(mockCart).forEach((fn) => fn.mockReset());
  mockProduct.findUnique.mockReset();
});

describe('GET /api/cart', () => {
  it("returns the logged-in user's cart, joined with product data", async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: inStockProduct(),
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

  it('drops rows whose product was soft-deleted after being added', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: inStockProduct({ isDeleted: true }),
      },
    ]);

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

  it('opportunistically sweeps orphaned rows (gone/soft-deleted product) from the DB', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_good',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 1,
        product: inStockProduct(),
      },
      {
        id: 'cart_soft_deleted',
        userId: 'user_1',
        productId: 'prod_2',
        quantity: 1,
        product: inStockProduct({ id: 'prod_2', isDeleted: true }),
      },
      {
        id: 'cart_ghost',
        userId: 'user_1',
        productId: 'prod_ghost',
        quantity: 1,
        product: null,
      },
    ]);
    mockCart.deleteMany.mockResolvedValue({ count: 2 });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('cart_good');

    // Sweep is fire-and-forget; give its microtask a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockCart.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['cart_soft_deleted', 'cart_ghost'] } },
    });
  });

  it('never fails the read if the orphan sweep itself errors', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_soft_deleted',
        userId: 'user_1',
        productId: 'prod_2',
        quantity: 1,
        product: inStockProduct({ id: 'prod_2', isDeleted: true }),
      },
    ]);
    mockCart.deleteMany.mockRejectedValue(new Error('sweep failed'));

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
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

  it('422s when an item quantity exceeds the sanity ceiling', async () => {
    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 10001 }] });

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
    mockProduct.findUnique.mockResolvedValue(inStockProduct());
    mockCart.deleteMany.mockResolvedValue({ count: 1 });
    mockCart.createMany.mockResolvedValue({ count: 2 });
    mockCart.findMany.mockResolvedValue([]);

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

  it("includes the new cart's summary, derived from the same write it just did", async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ price: 199 }));
    mockCart.deleteMany.mockResolvedValue({ count: 0 });
    mockCart.createMany.mockResolvedValue({ count: 1 });
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: inStockProduct({ price: 199 }),
      },
    ]);

    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.meta.summary).toEqual({
      subtotal: 398,
      deliveryCharge: 49,
      total: 447,
    });
  });

  it('404s and writes nothing when an item references a product that no longer exists', async () => {
    mockProduct.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_ghost', quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(mockCart.deleteMany).not.toHaveBeenCalled();
  });

  it('409s and writes nothing when the requested quantity exceeds stock', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ stock: 1 }));

    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 5 }] });

    expect(res.status).toBe(409);
    expect(mockCart.deleteMany).not.toHaveBeenCalled();
  });

  it('propagates a database error through the error handler', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct());
    mockCart.deleteMany.mockRejectedValue(new Error('write failed'));

    const res = await request(app)
      .post('/api/cart')
      .send({ cartItems: [{ productId: 'prod_1', quantity: 1 }] });

    expect(res.status).toBe(500);
  });
});

describe('PUT /api/cart', () => {
  it('creates the line item when it does not exist yet (upsert, not update-only)', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct());
    mockCart.upsert.mockResolvedValue({
      id: 'cart_new',
      userId: 'user_1',
      productId: 'prod_1',
      quantity: 3,
      product: inStockProduct(),
    });
    // The post-write summary re-read (see cart.controller.js's
    // updateCartItem) hits findMany again — double it here the same way
    // GET /api/cart's tests do.
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_new',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 3,
        product: inStockProduct(),
      },
    ]);

    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1', quantity: 3 });

    expect(res.status).toBe(200);
    expect(mockCart.upsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_1' } },
      update: { quantity: 3 },
      create: { userId: 'user_1', productId: 'prod_1', quantity: 3 },
      include: { product: true },
    });
  });

  it('404s when the product no longer exists', async () => {
    mockProduct.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_ghost', quantity: 1 });

    expect(res.status).toBe(404);
    expect(mockCart.upsert).not.toHaveBeenCalled();
  });

  it('409s when the requested quantity exceeds stock', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ stock: 2 }));

    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1', quantity: 10 });

    expect(res.status).toBe(409);
    expect(res.body.message.toLowerCase()).toContain('stock');
    expect(mockCart.upsert).not.toHaveBeenCalled();
  });

  it('includes the available stock in the structured error payload on a 409', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ stock: 2 }));

    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1', quantity: 10 });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual({ productId: 'prod_1', availableStock: 2 });
  });

  it('422s when quantity exceeds the sanity ceiling', async () => {
    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1', quantity: 10001 });

    expect(res.status).toBe(422);
    expect(mockCart.upsert).not.toHaveBeenCalled();
  });

  it('422s when quantity is missing', async () => {
    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(422);
    expect(mockCart.upsert).not.toHaveBeenCalled();
  });

  it("includes the whole cart's post-write summary, not just the changed line item", async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ price: 199 }));
    mockCart.upsert.mockResolvedValue({
      id: 'cart_new',
      userId: 'user_1',
      productId: 'prod_1',
      quantity: 3,
      product: inStockProduct({ price: 199 }),
    });
    // A second, unrelated item already in the cart — proves the summary
    // reflects the full cart, not a synthetic one built from just the
    // upserted row.
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_new',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 3,
        product: inStockProduct({ price: 199 }),
      },
      {
        id: 'cart_other',
        userId: 'user_1',
        productId: 'prod_2',
        quantity: 1,
        product: inStockProduct({ id: 'prod_2', price: 100 }),
      },
    ]);

    const res = await request(app)
      .put('/api/cart')
      .send({ productId: 'prod_1', quantity: 3 });

    expect(res.status).toBe(200);
    // subtotal = 3*199 + 1*100 = 697 -> clears the ₹600 free-delivery threshold
    expect(res.body.meta.summary).toEqual({
      subtotal: 697,
      deliveryCharge: 0,
      total: 697,
    });
  });
});

describe('DELETE /api/cart', () => {
  it('removes the item when it exists', async () => {
    mockCart.deleteMany.mockResolvedValue({ count: 1 });
    // Post-removal summary re-read (see cart.controller.js's removeFromCart).
    mockCart.findMany.mockResolvedValue([]);

    const res = await request(app)
      .delete('/api/cart')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Item removed from cart');
    expect(mockCart.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', productId: 'prod_1' },
    });
  });

  it('404s when the item is not in the cart (already removed elsewhere)', async () => {
    mockCart.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete('/api/cart')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(404);
  });

  it('422s when productId is missing', async () => {
    const res = await request(app).delete('/api/cart').send({});

    expect(res.status).toBe(422);
    expect(mockCart.deleteMany).not.toHaveBeenCalled();
  });

  it("includes the remaining cart's summary after removal", async () => {
    mockCart.deleteMany.mockResolvedValue({ count: 1 });
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_other',
        userId: 'user_1',
        productId: 'prod_2',
        quantity: 2,
        product: inStockProduct({ id: 'prod_2', price: 50 }),
      },
    ]);

    const res = await request(app)
      .delete('/api/cart')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(200);
    expect(res.body.meta.summary).toEqual({
      subtotal: 100,
      deliveryCharge: 49,
      total: 149,
    });
  });
});

// Discount/coupon placeholder architecture — see cart.service.js's
// previewCoupon / src/constants/pricing.js's calculateDiscount. No Coupon
// model exists yet, so every non-empty code currently 404s; these tests
// pin that behavior (and that a valid cart summary is still computed
// against live product data, not anything the client sent) so the seam
// doesn't quietly change shape later.
describe('POST /api/cart/coupon', () => {
  it('422s when couponCode is missing', async () => {
    const res = await request(app).post('/api/cart/coupon').send({});

    expect(res.status).toBe(422);
    expect(mockCart.findMany).not.toHaveBeenCalled();
  });

  it("400s when the caller's cart is empty", async () => {
    mockCart.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/cart/coupon')
      .send({ couponCode: 'SAVE10' });

    expect(res.status).toBe(400);
  });

  it('404s for any coupon code against a non-empty cart (no coupons exist yet)', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: inStockProduct(),
      },
    ]);

    const res = await request(app)
      .post('/api/cart/coupon')
      .send({ couponCode: 'SAVE10' });

    expect(res.status).toBe(404);
    expect(res.body.errors).toEqual({ couponCode: 'SAVE10' });
  });
});

describe('GET /api/cart — summary meta', () => {
  it('includes a subtotal/deliveryCharge/total summary computed from live product data', async () => {
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 2,
        product: inStockProduct({ price: 199 }), // 398 subtotal -> below ₹600 threshold
      },
    ]);

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    expect(res.body.meta.summary).toEqual({
      subtotal: 398,
      deliveryCharge: 49,
      total: 447,
    });
  });
});

// Regression coverage for one specific invariant: the client can never
// influence the delivery charge (or subtotal/total/price) that actually
// gets persisted or shown — every number here is derived server-side from
// live product data (calculateDeliveryCharge / summarizeCart), never from
// the request body. These tests send an otherwise-valid request with
// hostile pricing fields tacked on and assert the server-computed value
// wins every time, to catch a future change that accidentally starts
// reading (or spreading) a price-shaped field off req.body.
describe('pricing fields in the request body can never override the server-computed charge', () => {
  it('PUT /api/cart: a client-supplied deliveryCharge/price/total is never written or echoed back', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ price: 199 })); // below ₹600 threshold
    mockCart.upsert.mockResolvedValue({
      id: 'cart_1',
      userId: 'user_1',
      productId: 'prod_1',
      quantity: 1,
      product: inStockProduct({ price: 199 }),
    });
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 1,
        product: inStockProduct({ price: 199 }),
      },
    ]);

    const res = await request(app).put('/api/cart').send({
      productId: 'prod_1',
      quantity: 1,
      // Hostile extras a tampered client might try to sneak in:
      deliveryCharge: 0,
      shippingCharge: 0,
      price: 1, // try to overwrite the product's real ₹199 price
      total: 1,
      discount: 500,
    });

    expect(res.status).toBe(200);
    // The upsert only ever wrote productId/quantity — nothing price-shaped
    // was passed to Prisma, regardless of what was in the body.
    expect(mockCart.upsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_1' } },
      update: { quantity: 1 },
      create: { userId: 'user_1', productId: 'prod_1', quantity: 1 },
      include: { product: true },
    });
    // The response summary still reflects the real ₹199 product price
    // (below the ₹600 threshold -> ₹49 delivery charge), not the
    // ₹0 delivery / ₹1 total the request body tried to claim.
    expect(res.body.meta.summary).toEqual({
      subtotal: 199,
      deliveryCharge: 49,
      total: 248,
    });
  });

  it('POST /api/cart: a client-supplied per-item price/deliveryCharge is ignored — the live product price always wins', async () => {
    mockProduct.findUnique.mockResolvedValue(inStockProduct({ price: 199 }));
    mockCart.deleteMany.mockResolvedValue({});
    mockCart.createMany.mockResolvedValue({});
    mockCart.findMany.mockResolvedValue([
      {
        id: 'cart_1',
        userId: 'user_1',
        productId: 'prod_1',
        quantity: 1,
        product: inStockProduct({ price: 199 }),
      },
    ]);

    const res = await request(app)
      .post('/api/cart')
      .send({
        cartItems: [
          // A tampered client claiming this item costs ₹1 with free delivery.
          { productId: 'prod_1', quantity: 1, price: 1, deliveryCharge: 0 },
        ],
      });

    expect(res.status).toBe(200);
    // createMany only ever receives productId/quantity per item (see
    // cart.service.js's saveUserCart) — never a client-supplied price.
    expect(mockCart.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user_1', productId: 'prod_1', quantity: 1 }],
    });
    expect(res.body.meta.summary).toEqual({
      subtotal: 199,
      deliveryCharge: 49,
      total: 248,
    });
  });
});
