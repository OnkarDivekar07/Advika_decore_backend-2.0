const express = require('express');
const request = require('supertest');

const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

jest.mock('@modules/admin/admin.service', () => ({
  getAdminStats: jest.fn(),
  getAllUsersWithStats: jest.fn(),
  getUserDetailById: jest.fn(),
  getCurrentAdmin: jest.fn(),
  login: jest.fn(),
}));

jest.mock('@modules/admin/admin.analytics.service', () => ({
  getAnalyticsOverview: jest.fn(),
  getRevenueTrend: jest.fn(),
}));

const adminAnalyticsService = require('@modules/admin/admin.analytics.service');
const adminRoutes = require('@modules/admin/admin.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

const jwt = require('jsonwebtoken');
const adminToken = jwt.sign({ userId: 'admin1', role: 'admin' }, process.env.JWT_SECRET);
const customerToken = jwt.sign({ userId: 'user1', role: 'customer' }, process.env.JWT_SECRET);

beforeEach(() => {
  mockRedis.incr.mockReset().mockResolvedValue(1);
  mockRedis.expire.mockReset().mockResolvedValue(1);
  adminAnalyticsService.getAnalyticsOverview.mockReset();
  adminAnalyticsService.getRevenueTrend.mockReset();
});

describe('GET /api/admin/analytics/overview', () => {
  it('401s with no token', async () => {
    const res = await request(app).get('/api/admin/analytics/overview');
    expect(res.status).toBe(401);
    expect(adminAnalyticsService.getAnalyticsOverview).not.toHaveBeenCalled();
  });

  it('403s for a non-admin token', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/overview')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
    expect(adminAnalyticsService.getAnalyticsOverview).not.toHaveBeenCalled();
  });

  it('422s on a malformed dateFrom, even with a valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/overview?dateFrom=not-a-date')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(422);
    expect(adminAnalyticsService.getAnalyticsOverview).not.toHaveBeenCalled();
  });

  it('422s when dateTo is before dateFrom', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/overview?dateFrom=2026-02-01&dateTo=2026-01-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(422);
    expect(adminAnalyticsService.getAnalyticsOverview).not.toHaveBeenCalled();
  });

  it('200s for a valid admin token, forwarding dateFrom/dateTo to the service', async () => {
    adminAnalyticsService.getAnalyticsOverview.mockResolvedValue({
      range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
      grossRevenue: 5000,
      paidOrderCount: 10,
      averageOrderValue: 500,
      orderCount: 12,
      deliveredOrders: 9,
      pendingOrders: 1,
      newCustomers: 4,
      totalActiveProducts: 30,
      definitions: {},
    });

    const res = await request(app)
      .get('/api/admin/analytics/overview?dateFrom=2026-01-01&dateTo=2026-01-31')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.grossRevenue).toBe(5000);
    expect(adminAnalyticsService.getAnalyticsOverview).toHaveBeenCalledWith({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    });
  });

  it('200s with no query params (all-time overview)', async () => {
    adminAnalyticsService.getAnalyticsOverview.mockResolvedValue({
      range: { from: null, to: null },
      grossRevenue: 0,
      paidOrderCount: 0,
      averageOrderValue: 0,
      orderCount: 0,
      deliveredOrders: 0,
      pendingOrders: 0,
      newCustomers: 0,
      totalActiveProducts: 0,
      definitions: {},
    });

    const res = await request(app)
      .get('/api/admin/analytics/overview')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.range).toEqual({ from: null, to: null });
  });
});

describe('GET /api/admin/analytics/revenue-trend', () => {
  it('401s with no token', async () => {
    const res = await request(app).get('/api/admin/analytics/revenue-trend');
    expect(res.status).toBe(401);
    expect(adminAnalyticsService.getRevenueTrend).not.toHaveBeenCalled();
  });

  it('403s for a non-admin token', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/revenue-trend')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('422s on an invalid granularity', async () => {
    const res = await request(app)
      .get('/api/admin/analytics/revenue-trend?granularity=yearly')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(422);
    expect(adminAnalyticsService.getRevenueTrend).not.toHaveBeenCalled();
  });

  it('200s and forwards granularity/date params to the service', async () => {
    adminAnalyticsService.getRevenueTrend.mockResolvedValue({
      range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
      granularity: 'week',
      buckets: [],
      definitions: {},
    });

    const res = await request(app)
      .get('/api/admin/analytics/revenue-trend?dateFrom=2026-01-01&dateTo=2026-01-31&granularity=week')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.granularity).toBe('week');
    expect(adminAnalyticsService.getRevenueTrend).toHaveBeenCalledWith({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      granularity: 'week',
    });
  });

  it('200s with no query params (defaults applied server-side)', async () => {
    adminAnalyticsService.getRevenueTrend.mockResolvedValue({
      range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-30T23:59:59.999Z' },
      granularity: 'day',
      buckets: [],
      definitions: {},
    });

    const res = await request(app)
      .get('/api/admin/analytics/revenue-trend')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.granularity).toBe('day');
  });
});
