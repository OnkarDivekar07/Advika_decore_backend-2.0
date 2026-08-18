const express = require('express');
const request = require('supertest');

// Authenticate is mocked to read the user id/role off headers so a single
// test file can exercise both the admin-only-success and non-admin-403 paths.
jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = {
      userId: req.headers['x-user-id'] || 'admin_1',
      role: req.headers['x-role'] || 'admin',
    };
    next();
  })
);

// Explicit factory (rather than automock) so requiring this test file never
// pulls in the real inventory.service.js / a real Prisma client.
jest.mock('@modules/inventory/inventory.service', () => ({
  getStockForProduct: jest.fn(),
  listLowStockProducts: jest.fn(),
  adjustStock: jest.fn(),
}));

const inventoryService = require('@modules/inventory/inventory.service');
const inventoryRoutes = require('@modules/inventory/inventory.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');
const CustomError = require('@utils/customError');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/inventory', inventoryRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const VALID_PRODUCT_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  Object.values(inventoryService).forEach((fn) => fn.mockReset());
});

describe('admin gate', () => {
  it('403s a non-admin on every inventory route', async () => {
    const resGet = await request(app)
      .get(`/api/inventory/${VALID_PRODUCT_ID}`)
      .set('x-role', 'customer');
    expect(resGet.status).toBe(403);

    const resLow = await request(app)
      .get('/api/inventory/low-stock')
      .set('x-role', 'customer');
    expect(resLow.status).toBe(403);

    const resPatch = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .set('x-role', 'customer')
      .send({ action: 'set', quantity: 5 });
    expect(resPatch.status).toBe(403);

    expect(inventoryService.getStockForProduct).not.toHaveBeenCalled();
    expect(inventoryService.listLowStockProducts).not.toHaveBeenCalled();
    expect(inventoryService.adjustStock).not.toHaveBeenCalled();
  });
});

describe('GET /api/inventory/:productId', () => {
  it('422s on a malformed product id', async () => {
    const res = await request(app).get('/api/inventory/not-an-id');

    expect(res.status).toBe(422);
    expect(inventoryService.getStockForProduct).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    inventoryService.getStockForProduct.mockRejectedValue(
      new CustomError('Product not found', 404)
    );

    const res = await request(app).get(`/api/inventory/${VALID_PRODUCT_ID}`);

    expect(res.status).toBe(404);
  });

  it('200s with the current stock', async () => {
    inventoryService.getStockForProduct.mockResolvedValue({
      id: VALID_PRODUCT_ID,
      name: 'Trail Runner',
      brand: 'Acme',
      stock: 42,
    });

    const res = await request(app).get(`/api/inventory/${VALID_PRODUCT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Stock fetched successfully');
    expect(res.body.data.stock).toBe(42);
  });
});

describe('GET /api/inventory/low-stock', () => {
  it('defaults the threshold to 10 when not provided', async () => {
    inventoryService.listLowStockProducts.mockResolvedValue([]);

    const res = await request(app).get('/api/inventory/low-stock');

    expect(res.status).toBe(200);
    expect(inventoryService.listLowStockProducts).toHaveBeenCalledWith(10);
    expect(res.body.meta.threshold).toBe(10);
  });

  it('uses a custom threshold when provided', async () => {
    inventoryService.listLowStockProducts.mockResolvedValue([
      { id: VALID_PRODUCT_ID, name: 'Trail Runner', stock: 2 },
    ]);

    const res = await request(app).get('/api/inventory/low-stock?threshold=5');

    expect(res.status).toBe(200);
    // Note: the controller reads req.query.threshold directly rather than a
    // sanitized value, so this arrives as the raw query string, not a number.
    expect(inventoryService.listLowStockProducts).toHaveBeenCalledWith('5');
    expect(res.body.meta.threshold).toBe('5');
    expect(res.body.data).toHaveLength(1);
  });

  it('422s on a negative threshold', async () => {
    const res = await request(app).get(
      '/api/inventory/low-stock?threshold=-1'
    );

    expect(res.status).toBe(422);
    expect(inventoryService.listLowStockProducts).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/inventory/:productId', () => {
  it('422s on an invalid action', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'nuke', quantity: 5 });

    expect(res.status).toBe(422);
    expect(inventoryService.adjustStock).not.toHaveBeenCalled();
  });

  it('422s when quantity is missing', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set' });

    expect(res.status).toBe(422);
  });

  it('422s when quantity is negative', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'increment', quantity: -3 });

    expect(res.status).toBe(422);
  });

  it('sets stock to an exact value', async () => {
    inventoryService.adjustStock.mockResolvedValue({
      id: VALID_PRODUCT_ID,
      stock: 20,
    });

    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set', quantity: 20 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Stock updated successfully');
    expect(inventoryService.adjustStock).toHaveBeenCalledWith(
      VALID_PRODUCT_ID,
      'set',
      20
    );
  });

  it('409s when a decrement exceeds the available stock', async () => {
    inventoryService.adjustStock.mockRejectedValue(
      new CustomError(
        'Insufficient stock for one or more items in this order',
        409,
        { insufficientItems: [{ productId: VALID_PRODUCT_ID, quantity: 100 }] }
      )
    );

    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'decrement', quantity: 100 });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual({
      insufficientItems: [{ productId: VALID_PRODUCT_ID, quantity: 100 }],
    });
  });

  it('422s when expectedStock is not a non-negative integer', async () => {
    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set', quantity: 20, expectedStock: -1 });

    expect(res.status).toBe(422);
    expect(inventoryService.adjustStock).not.toHaveBeenCalled();
  });

  it('omits expectedStock from the service call when not provided (previous behavior)', async () => {
    inventoryService.adjustStock.mockResolvedValue({ id: VALID_PRODUCT_ID, stock: 20 });

    await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set', quantity: 20 });

    expect(inventoryService.adjustStock).toHaveBeenCalledWith(
      VALID_PRODUCT_ID,
      'set',
      20
    );
  });

  it('forwards expectedStock to the service as an optimistic-concurrency precondition', async () => {
    inventoryService.adjustStock.mockResolvedValue({ id: VALID_PRODUCT_ID, stock: 20 });

    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set', quantity: 20, expectedStock: 8 });

    expect(res.status).toBe(200);
    expect(inventoryService.adjustStock).toHaveBeenCalledWith(
      VALID_PRODUCT_ID,
      'set',
      20,
      8
    );
  });

  it('409s with the authoritative current stock when expectedStock is stale', async () => {
    inventoryService.adjustStock.mockRejectedValue(
      new CustomError('Stock has changed since it was loaded. Refresh and try again.', 409, {
        currentStock: 14,
      })
    );

    const res = await request(app)
      .patch(`/api/inventory/${VALID_PRODUCT_ID}`)
      .send({ action: 'set', quantity: 20, expectedStock: 8 });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual({ currentStock: 14 });
  });
});
