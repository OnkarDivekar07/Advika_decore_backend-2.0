const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@modules/content/content.service', () => ({
  getAllContent: jest.fn(),
  upsertContent: jest.fn(),
}));

const contentService = require('@modules/content/content.service');
const contentRoutes = require('@modules/content/content.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/content', contentRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const adminToken = jwt.sign(
  { userId: 'admin1', role: 'admin' },
  process.env.JWT_SECRET
);
const customerToken = jwt.sign(
  { userId: 'user1', role: 'customer' },
  process.env.JWT_SECRET
);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/content (public)', () => {
  it('lists site content with no auth required', async () => {
    contentService.getAllContent.mockResolvedValue([
      { key: 'ticker.cod', valueEn: 'CASH ON DELIVERY', valueHi: 'H', valueMr: 'M' },
    ]);

    const res = await request(app).get('/api/content');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { key: 'ticker.cod', valueEn: 'CASH ON DELIVERY', valueHi: 'H', valueMr: 'M' },
    ]);
  });
});

describe('PATCH /api/content/:key (admin only)', () => {
  it('401s with no token', async () => {
    const res = await request(app).patch('/api/content/ticker.cod');
    expect(res.status).toBe(401);
    expect(contentService.upsertContent).not.toHaveBeenCalled();
  });

  it('403s a non-admin token', async () => {
    const res = await request(app)
      .patch('/api/content/ticker.cod')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ valueEn: 'a', valueHi: 'b', valueMr: 'c' });

    expect(res.status).toBe(403);
    expect(contentService.upsertContent).not.toHaveBeenCalled();
  });

  it('422s an invalid key (not a dotted letters/digits/underscore path)', async () => {
    const res = await request(app)
      .patch('/api/content/ticker$cod')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valueEn: 'a', valueHi: 'b', valueMr: 'c' });

    expect(res.status).toBe(422);
    expect(contentService.upsertContent).not.toHaveBeenCalled();
  });

  // Regression test: the key-validation regex originally only allowed
  // letters/digits/underscore, which rejected every real hyphenated
  // category key (e.g. "category.steering-cover.label", matching
  // frontend-improved/src/config/advikaAuto.js's kebab-case category ids)
  // at the HTTP layer even though the seed script had already written
  // those exact rows fine (seeding bypasses this validator, going straight
  // through Prisma) — so admin edits to 8 of the 9 real category rows
  // silently 422'd until this was fixed.
  it('accepts a hyphenated key segment (e.g. a kebab-case category id)', async () => {
    contentService.upsertContent.mockResolvedValue({
      key: 'category.steering-cover.label',
      valueEn: 'Steering Cover',
      valueHi: 'a',
      valueMr: 'b',
    });

    const res = await request(app)
      .patch('/api/content/category.steering-cover.label')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valueEn: 'Steering Cover', valueHi: 'a', valueMr: 'b' });

    expect(res.status).toBe(200);
    expect(contentService.upsertContent).toHaveBeenCalledWith(
      'category.steering-cover.label',
      { valueEn: 'Steering Cover', valueHi: 'a', valueMr: 'b' }
    );
  });

  it('422s when a language value is missing', async () => {
    const res = await request(app)
      .patch('/api/content/ticker.cod')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valueEn: 'a', valueHi: '', valueMr: 'c' });

    expect(res.status).toBe(422);
    expect(contentService.upsertContent).not.toHaveBeenCalled();
  });

  it('updates the content row for a valid admin request', async () => {
    contentService.upsertContent.mockResolvedValue({
      key: 'ticker.cod',
      valueEn: 'CASH ON DELIVERY',
      valueHi: 'नई हिंदी',
      valueMr: 'नवीन मराठी',
    });

    const res = await request(app)
      .patch('/api/content/ticker.cod')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ valueEn: 'CASH ON DELIVERY', valueHi: 'नई हिंदी', valueMr: 'नवीन मराठी' });

    expect(res.status).toBe(200);
    expect(contentService.upsertContent).toHaveBeenCalledWith('ticker.cod', {
      valueEn: 'CASH ON DELIVERY',
      valueHi: 'नई हिंदी',
      valueMr: 'नवीन मराठी',
    });
    expect(res.body.data.valueHi).toBe('नई हिंदी');
  });
});
