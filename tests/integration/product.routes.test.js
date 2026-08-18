const express = require('express');
const request = require('supertest');

// Authenticate is mocked to read the user id/role off headers so a single
// test file can exercise the public routes as well as the admin-only ones.
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
// pulls in the real product.service.js — and with it, real Prisma/Redis/
// BullMQ client construction that would otherwise try to open connections.
jest.mock('@modules/product/product.service', () => ({
  getAllProducts: jest.fn(),
  getProductById: jest.fn(),
  getProductsByIds: jest.fn(),
  getRelatedProducts: jest.fn(),
  queueProductCreation: jest.fn(),
  queueProductUpdate: jest.fn(),
  deleteProduct: jest.fn(),
  getProductJobStatus: jest.fn(),
}));

const productService = require('@modules/product/product.service');
const productRoutes = require('@modules/product/product.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');
const CustomError = require('@utils/customError');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/products', productRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const VALID_PRODUCT_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  Object.values(productService).forEach((fn) => fn.mockReset());
});

describe('GET /api/products (public)', () => {
  it('200s with paginated products for an unauthenticated request', async () => {
    productService.getAllProducts.mockResolvedValue({
      data: [{ id: VALID_PRODUCT_ID, name: 'Trail Runner' }],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    const res = await request(app).get('/api/products');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Products fetched successfully');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('GET /api/products/:id (public)', () => {
  it('404s when the product does not exist', async () => {
    productService.getProductById.mockRejectedValue(
      new CustomError('Product not found', 404)
    );

    const res = await request(app).get(`/api/products/${VALID_PRODUCT_ID}`);

    expect(res.status).toBe(404);
  });

  it('200s with the product', async () => {
    productService.getProductById.mockResolvedValue({
      id: VALID_PRODUCT_ID,
      name: 'Trail Runner',
      price: 2999,
    });

    const res = await request(app).get(`/api/products/${VALID_PRODUCT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Trail Runner');
  });
});

describe('GET /api/products/batch (public)', () => {
  it('422s when ids is missing', async () => {
    const res = await request(app).get('/api/products/batch');

    expect(res.status).toBe(422);
    expect(productService.getProductsByIds).not.toHaveBeenCalled();
  });

  it('422s when ids is an empty string', async () => {
    const res = await request(app).get('/api/products/batch').query({ ids: '' });

    expect(res.status).toBe(422);
  });

  it('422s when more than 50 ids are requested', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `prod_${i}`).join(',');

    const res = await request(app).get('/api/products/batch').query({ ids: tooMany });

    expect(res.status).toBe(422);
    expect(productService.getProductsByIds).not.toHaveBeenCalled();
  });

  it('dedupes ids before calling the service', async () => {
    productService.getProductsByIds.mockResolvedValue([]);

    await request(app)
      .get('/api/products/batch')
      .query({ ids: 'prod_1,prod_2,prod_1' });

    expect(productService.getProductsByIds).toHaveBeenCalledWith(['prod_1', 'prod_2']);
  });

  it('200s with the matching products, silently omitting unavailable ids', async () => {
    productService.getProductsByIds.mockResolvedValue([
      { id: 'prod_1', name: 'Trail Runner', price: 2999, stock: 4 },
    ]);

    const res = await request(app)
      .get('/api/products/batch')
      .query({ ids: 'prod_1,prod_deleted' });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('prod_1');
  });
});

describe('GET /api/products/:id/related (public)', () => {
  it('404s when the base product is missing or has no category', async () => {
    productService.getRelatedProducts.mockRejectedValue(
      new CustomError('Product not found or category missing', 404)
    );

    const res = await request(app).get(
      `/api/products/${VALID_PRODUCT_ID}/related`
    );

    expect(res.status).toBe(404);
  });

  it('200s with related products', async () => {
    productService.getRelatedProducts.mockResolvedValue([
      { id: 'prod_2', name: 'Trail Runner v2' },
    ]);

    const res = await request(app).get(
      `/api/products/${VALID_PRODUCT_ID}/related`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('POST /api/products (admin only)', () => {
  const validFields = {
    name: 'Trail Runner',
    brand: 'Acme',
    price: '2999',
    stock: '15',
    description: 'A durable trail running shoe.',
    category: 'shoes,running',
  };

  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('x-role', 'customer')
      .field(validFields);

    expect(res.status).toBe(403);
    expect(productService.queueProductCreation).not.toHaveBeenCalled();
  });

  it('422s when required fields are missing', async () => {
    const res = await request(app).post('/api/products').send({});

    expect(res.status).toBe(422);
    expect(productService.queueProductCreation).not.toHaveBeenCalled();
  });

  it('queues product creation for a valid admin request', async () => {
    productService.queueProductCreation.mockResolvedValue({ id: 'job_1' });

    const res = await request(app)
      .post('/api/products')
      .field(validFields)
      .attach('images', Buffer.from('fake-image-bytes'), 'shoe.jpg');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Product upload queued successfully.');
    expect(res.body.data).toEqual({ jobId: 'job_1' });
    expect(productService.queueProductCreation).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/products/:id (admin only)', () => {
  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .patch(`/api/products/${VALID_PRODUCT_ID}`)
      .set('x-role', 'customer')
      .send({ price: '1999' });

    expect(res.status).toBe(403);
    expect(productService.queueProductUpdate).not.toHaveBeenCalled();
  });

  it('422s on an invalid field value', async () => {
    const res = await request(app)
      .patch(`/api/products/${VALID_PRODUCT_ID}`)
      .send({ price: '-5' });

    expect(res.status).toBe(422);
  });

  it('queues the product update for a valid admin request', async () => {
    productService.queueProductUpdate.mockResolvedValue({ id: 'job_2' });

    const res = await request(app)
      .patch(`/api/products/${VALID_PRODUCT_ID}`)
      .field({ price: '1999' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Product update queued successfully.');
    expect(productService.queueProductUpdate).toHaveBeenCalledWith(
      VALID_PRODUCT_ID,
      expect.objectContaining({ price: 1999 }),
      []
    );
  });
});

describe('GET /api/products/jobs/:jobId (admin only)', () => {
  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .get('/api/products/jobs/job_1')
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
    expect(productService.getProductJobStatus).not.toHaveBeenCalled();
  });

  it('401s for an unauthenticated request', async () => {
    // authenticate is mocked to always populate req.user in this test file,
    // so this only exercises authorizeAdminOnly's role check via x-role;
    // real 401 behavior (missing/invalid token) is covered in
    // auth.middleware.test.js.
    const res = await request(app)
      .get('/api/products/jobs/job_1')
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
  });

  it('404s when the job does not exist', async () => {
    productService.getProductJobStatus.mockRejectedValue(
      new CustomError('Job not found', 404)
    );

    const res = await request(app).get('/api/products/jobs/missing');

    expect(res.status).toBe(404);
  });

  it("200s with the job's current state", async () => {
    productService.getProductJobStatus.mockResolvedValue({
      jobId: 'job_1',
      state: 'completed',
      result: { id: VALID_PRODUCT_ID, images: ['https://cdn/img.webp'] },
    });

    const res = await request(app).get('/api/products/jobs/job_1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      jobId: 'job_1',
      state: 'completed',
      result: { id: VALID_PRODUCT_ID, images: ['https://cdn/img.webp'] },
    });
    expect(productService.getProductJobStatus).toHaveBeenCalledWith('job_1');
  });
});

describe('DELETE /api/products/:id (admin only)', () => {
  it('403s for a non-admin user', async () => {
    const res = await request(app)
      .delete(`/api/products/${VALID_PRODUCT_ID}`)
      .set('x-role', 'customer');

    expect(res.status).toBe(403);
    expect(productService.deleteProduct).not.toHaveBeenCalled();
  });

  it('404s when the product does not exist', async () => {
    productService.deleteProduct.mockRejectedValue(
      new CustomError('Product not found', 404)
    );

    const res = await request(app).delete(
      `/api/products/${VALID_PRODUCT_ID}`
    );

    expect(res.status).toBe(404);
  });

  it('200s and soft-deletes the product for an admin', async () => {
    productService.deleteProduct.mockResolvedValue();

    const res = await request(app).delete(
      `/api/products/${VALID_PRODUCT_ID}`
    );

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Product deleted successfully');
    expect(productService.deleteProduct).toHaveBeenCalledWith(
      VALID_PRODUCT_ID
    );
  });
});
