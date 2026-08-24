const express = require('express');
const request = require('supertest');

const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

// Same explicit-factory pattern as admin.routes.test.js — admin.controller.js
// pulls in both admin.service.js and admin.analytics.service.js, and the
// real admin.service.js pulls in paginateWithCache -> @config/redis.
jest.mock('@modules/admin/admin.service', () => ({
  getAdminStats: jest.fn(),
  getAllUsersWithStats: jest.fn(),
  getUserDetailById: jest.fn(),
  login: jest.fn(),
  getOperationalAlerts: jest.fn(),
}));
jest.mock('@modules/admin/admin.analytics.service', () => ({
  getAnalyticsOverview: jest.fn(),
  getRevenueTrend: jest.fn(),
}));

const adminService = require('@modules/admin/admin.service');
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
const adminToken = jwt.sign(
  { userId: 'admin1', role: 'admin' },
  process.env.JWT_SECRET
);
const customerToken = jwt.sign(
  { userId: 'user1', role: 'customer' },
  process.env.JWT_SECRET
);

const emptyAlerts = {
  lowStock: { threshold: 10, count: 0, items: [] },
  pendingOrders: { count: 0, items: [] },
  paymentExceptions: { count: 0, items: [] },
  shipmentExceptions: { count: 0, items: [] },
  generatedAt: '2026-08-19T00:00:00.000Z',
};

describe('GET /api/admin/alerts', () => {
  beforeEach(() => {
    adminService.getOperationalAlerts.mockReset();
  });

  it('401s with no token', async () => {
    const res = await request(app).get('/api/admin/alerts');
    expect(res.status).toBe(401);
    expect(adminService.getOperationalAlerts).not.toHaveBeenCalled();
  });

  it('403s for a non-admin token', async () => {
    const res = await request(app)
      .get('/api/admin/alerts')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
    expect(adminService.getOperationalAlerts).not.toHaveBeenCalled();
  });

  it('422s a negative lowStockThreshold, even with a valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/alerts?lowStockThreshold=-1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(adminService.getOperationalAlerts).not.toHaveBeenCalled();
  });

  it('422s a non-integer lowStockThreshold', async () => {
    const res = await request(app)
      .get('/api/admin/alerts?lowStockThreshold=abc')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(adminService.getOperationalAlerts).not.toHaveBeenCalled();
  });

  it('200s for a valid admin token and returns exactly what the service reports', async () => {
    adminService.getOperationalAlerts.mockResolvedValue(emptyAlerts);

    const res = await request(app)
      .get('/api/admin/alerts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(emptyAlerts);
  });

  it('passes a provided lowStockThreshold through to the service', async () => {
    adminService.getOperationalAlerts.mockResolvedValue(emptyAlerts);

    await request(app)
      .get('/api/admin/alerts?lowStockThreshold=5')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(adminService.getOperationalAlerts).toHaveBeenCalledWith({
      lowStockThreshold: 5,
    });
  });

  it('propagates a service-layer error through the standard error handler', async () => {
    const CustomError = require('@utils/customError');
    adminService.getOperationalAlerts.mockRejectedValue(
      new CustomError('DB unreachable', 500)
    );

    const res = await request(app)
      .get('/api/admin/alerts')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
  });
});
