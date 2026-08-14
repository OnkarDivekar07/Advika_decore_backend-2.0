const express = require('express');
const request = require('supertest');

// Explicit factory (rather than automock) so requiring this test file never
// pulls in a real Prisma client / DB connection — wishlist.service talks to
// prisma directly, so we double the exact methods it calls.
const mockWishlist = {
  findMany: jest.fn(),
  findUnique: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
};
const mockProduct = {
  findUnique: jest.fn(),
};
jest.mock('@config/prisma', () => ({
  wishlist: mockWishlist,
  product: mockProduct,
}));

const wishlistRoutes = require('@modules/wishlist/wishlist.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

// authenticate is mocked per-suite (not once at module scope) because the
// auth-guard tests below need to exercise the *real* middleware — every
// other suite just wants a logged-in user without re-deriving a JWT.
jest.mock('@middlewares/authenticate');
const authenticate = require('@middlewares/authenticate');

const asAuthenticated = () =>
  authenticate.mockImplementation((req, res, next) => {
    req.user = { userId: 'user_1', role: 'customer' };
    next();
  });

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/wishlist', wishlistRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const activeProduct = (overrides = {}) => ({
  id: 'prod_1',
  name: 'Running Shoe',
  price: 1999,
  stock: 10,
  isDeleted: false,
  ...overrides,
});

beforeEach(() => {
  Object.values(mockWishlist).forEach((fn) => fn.mockReset());
  mockProduct.findUnique.mockReset();
  asAuthenticated();
});

// Every wishlist route sits behind `authenticate` (see wishlist.routes.js —
// there's no guest/anonymous wishlist, unlike Cart). We don't re-test
// authenticate's own token-verification logic here (that's
// auth.middleware.test.js's job) — what these guard against is
// wishlist.routes.js itself quietly losing its `router.use(authenticate)`
// line. Simulating the real middleware's reject-path (calling next with a
// 401, never populating req.user) and asserting the request is turned away
// before the controller/service ever runs is what actually catches that.
describe('auth guard — all wishlist routes require a logged-in user', () => {
  const CustomError = require('@utils/customError');
  const rejectUnauthenticated = (req, res, next) =>
    next(new CustomError('Unauthorized', 401));

  it('GET /api/wishlist is turned away when the request is unauthenticated', async () => {
    authenticate.mockImplementation(rejectUnauthenticated);

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(401);
    expect(mockWishlist.findMany).not.toHaveBeenCalled();
  });

  it('POST /api/wishlist is turned away when the request is unauthenticated', async () => {
    authenticate.mockImplementation(rejectUnauthenticated);

    const res = await request(app).post('/api/wishlist').send({ productId: 'prod_1' });

    expect(res.status).toBe(401);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('DELETE /api/wishlist/:productId is turned away when the request is unauthenticated', async () => {
    authenticate.mockImplementation(rejectUnauthenticated);

    const res = await request(app).delete('/api/wishlist/prod_1');

    expect(res.status).toBe(401);
    expect(mockWishlist.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/wishlist', () => {
  it("returns the logged-in user's wishlist, joined with product data", async () => {
    mockWishlist.findMany.mockResolvedValue([
      {
        id: 'wish_1',
        userId: 'user_1',
        productId: 'prod_1',
        createdAt: new Date('2024-01-01'),
        product: activeProduct(),
      },
    ]);

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Wishlist fetched successfully');
    expect(mockWishlist.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].product.name).toBe('Running Shoe');
  });

  it('returns an empty array when the wishlist has no items', async () => {
    mockWishlist.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('drops rows whose product was soft-deleted after being wishlisted', async () => {
    mockWishlist.findMany.mockResolvedValue([
      {
        id: 'wish_1',
        userId: 'user_1',
        productId: 'prod_1',
        product: activeProduct({ isDeleted: true }),
      },
    ]);

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('opportunistically sweeps orphaned rows (gone/soft-deleted product) from the DB', async () => {
    mockWishlist.findMany.mockResolvedValue([
      {
        id: 'wish_good',
        userId: 'user_1',
        productId: 'prod_1',
        product: activeProduct(),
      },
      {
        id: 'wish_soft_deleted',
        userId: 'user_1',
        productId: 'prod_2',
        product: activeProduct({ id: 'prod_2', isDeleted: true }),
      },
      {
        id: 'wish_ghost',
        userId: 'user_1',
        productId: 'prod_ghost',
        product: null,
      },
    ]);
    mockWishlist.deleteMany.mockResolvedValue({ count: 2 });

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('wish_good');

    // Sweep is fire-and-forget; give its microtask a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockWishlist.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['wish_soft_deleted', 'wish_ghost'] } },
    });
  });

  it('never fails the read if the orphan sweep itself errors', async () => {
    mockWishlist.findMany.mockResolvedValue([
      {
        id: 'wish_soft_deleted',
        userId: 'user_1',
        productId: 'prod_2',
        product: activeProduct({ id: 'prod_2', isDeleted: true }),
      },
    ]);
    mockWishlist.deleteMany.mockRejectedValue(new Error('sweep failed'));

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('propagates a database error through the error handler', async () => {
    mockWishlist.findMany.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).get('/api/wishlist');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('only ever scopes the query to the authenticated user, never a client-supplied userId', async () => {
    mockWishlist.findMany.mockResolvedValue([]);

    // Even if a tampered client tries to pass a different userId via query
    // string, the service only ever reads it off req.user (set by the
    // authenticate middleware from the verified token) — never from the
    // request itself.
    await request(app).get('/api/wishlist').query({ userId: 'someone_else' });

    expect(mockWishlist.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('POST /api/wishlist', () => {
  it('422s when productId is missing', async () => {
    const res = await request(app).post('/api/wishlist').send({});

    expect(res.status).toBe(422);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('422s when productId is not a string', async () => {
    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 12345 });

    expect(res.status).toBe(422);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('422s when productId is an empty string', async () => {
    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: '' });

    expect(res.status).toBe(422);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    mockProduct.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 'prod_ghost' });

    expect(res.status).toBe(404);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('404s when the product has been soft-deleted', async () => {
    mockProduct.findUnique.mockResolvedValue(activeProduct({ isDeleted: true }));

    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(404);
    expect(mockWishlist.upsert).not.toHaveBeenCalled();
  });

  it('adds the product to the wishlist on a valid payload', async () => {
    mockProduct.findUnique.mockResolvedValue(activeProduct());
    mockWishlist.upsert.mockResolvedValue({
      id: 'wish_1',
      userId: 'user_1',
      productId: 'prod_1',
      product: activeProduct(),
    });

    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Added to wishlist');
    expect(mockWishlist.upsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_1' } },
      update: {},
      create: { userId: 'user_1', productId: 'prod_1' },
      include: { product: true },
    });
    expect(res.body.data.product.name).toBe('Running Shoe');
  });

  it('re-adding an already-wishlisted product is a harmless no-op (upsert), not a conflict error', async () => {
    mockProduct.findUnique.mockResolvedValue(activeProduct());
    mockWishlist.upsert.mockResolvedValue({
      id: 'wish_1',
      userId: 'user_1',
      productId: 'prod_1',
      product: activeProduct(),
    });

    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(200);
    // Upsert, not create — a duplicate add must never surface a
    // unique-constraint error to the frontend.
    expect(mockWishlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
  });

  it('propagates a database error through the error handler', async () => {
    mockProduct.findUnique.mockResolvedValue(activeProduct());
    mockWishlist.upsert.mockRejectedValue(new Error('write failed'));

    const res = await request(app)
      .post('/api/wishlist')
      .send({ productId: 'prod_1' });

    expect(res.status).toBe(500);
  });

  it('only ever writes the authenticated userId, never a client-supplied one', async () => {
    mockProduct.findUnique.mockResolvedValue(activeProduct());
    mockWishlist.upsert.mockResolvedValue({
      id: 'wish_1',
      userId: 'user_1',
      productId: 'prod_1',
      product: activeProduct(),
    });

    await request(app)
      .post('/api/wishlist')
      // Hostile extra: a tampered client trying to wishlist on someone
      // else's behalf.
      .send({ productId: 'prod_1', userId: 'someone_else' });

    expect(mockWishlist.upsert).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_1' } },
      update: {},
      create: { userId: 'user_1', productId: 'prod_1' },
      include: { product: true },
    });
  });
});

describe('DELETE /api/wishlist/:productId', () => {
  it('removes the item when it exists', async () => {
    mockWishlist.findUnique.mockResolvedValue({
      id: 'wish_1',
      userId: 'user_1',
      productId: 'prod_1',
    });
    mockWishlist.delete.mockResolvedValue({ id: 'wish_1' });

    const res = await request(app).delete('/api/wishlist/prod_1');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed from wishlist');
    expect(mockWishlist.findUnique).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_1' } },
    });
    expect(mockWishlist.delete).toHaveBeenCalledWith({ where: { id: 'wish_1' } });
  });

  it('404s when the item is not in the wishlist (already removed elsewhere)', async () => {
    mockWishlist.findUnique.mockResolvedValue(null);

    const res = await request(app).delete('/api/wishlist/prod_1');

    expect(res.status).toBe(404);
    expect(mockWishlist.delete).not.toHaveBeenCalled();
  });

  it('404s for a different (never-wishlisted) productId, scoped correctly per user', async () => {
    mockWishlist.findUnique.mockResolvedValue(null);

    const res = await request(app).delete('/api/wishlist/prod_never_added');

    expect(res.status).toBe(404);
    expect(mockWishlist.findUnique).toHaveBeenCalledWith({
      where: { userId_productId: { userId: 'user_1', productId: 'prod_never_added' } },
    });
  });

  it('propagates a database error through the error handler', async () => {
    mockWishlist.findUnique.mockRejectedValue(new Error('connection lost'));

    const res = await request(app).delete('/api/wishlist/prod_1');

    expect(res.status).toBe(500);
  });
});
