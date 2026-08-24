const express = require('express');
const request = require('supertest');

// admin.routes.js now runs POST /login through adminLoginRateLimiter, which
// talks to @config/redis directly (not through admin.service.js), so it
// needs its own mock here — same pattern as otp.routes.test.js.
const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

// Explicit factory (not automock) — the real admin.service.js pulls in
// paginateWithCache -> @config/redis, which would open a real Redis
// connection attempt just to introspect the module's shape.
jest.mock('@modules/admin/admin.service', () => ({
  getAdminStats: jest.fn(),
  getAllUsersWithStats: jest.fn(),
  getUserDetailById: jest.fn(),
  login: jest.fn(),
}));

// admin.controller.js also pulls in admin.analytics.service.js (PHASE 11)
// for the /analytics/* routes below — mocked here for the same reason as
// admin.service.js above: this suite is testing routing/validation/auth
// wiring, not the real service's Prisma queries, and admin.analytics.
// service.js's own behavior is covered by admin.analytics.service.test.js
// and admin.analytics.routes.test.js.
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

beforeEach(() => {
  mockRedis.incr.mockReset().mockResolvedValue(1);
  mockRedis.expire.mockReset().mockResolvedValue(1);
});

const jwt = require('jsonwebtoken');
const adminToken = jwt.sign(
  { userId: 'admin1', role: 'admin' },
  process.env.JWT_SECRET
);
const customerToken = jwt.sign(
  { userId: 'user1', role: 'customer' },
  process.env.JWT_SECRET
);

describe('POST /api/admin/login', () => {
  it('422s on a missing password', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@advika.com' });

    expect(res.status).toBe(422);
    expect(adminService.login).not.toHaveBeenCalled();
  });

  it('logs in with valid credentials', async () => {
    adminService.login.mockResolvedValue({
      token: 'jwt-token',
      user: {
        id: 'admin1',
        name: 'Admin',
        email: 'admin@advika.com',
        role: 'admin',
      },
    });

    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@advika.com', password: 'correct-password' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe('jwt-token');
  });

  it('propagates an invalid-credentials rejection with the right status', async () => {
    const CustomError = require('@utils/customError');
    adminService.login.mockRejectedValue(
      new CustomError('Incorrect password', 401)
    );

    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@advika.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('429s once the per-email login attempt cap is exceeded, without calling the service', async () => {
    mockRedis.incr.mockResolvedValue(11); // adminLoginRateLimiter maxAttempts is 10

    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@advika.com', password: 'wrong-password' });

    expect(res.status).toBe(429);
    expect(res.body.message).toBe(
      'Too many login attempts. Please try again later.'
    );
    expect(adminService.login).not.toHaveBeenCalled();
  });

  it('rate-limits missing-password requests too, since limiter runs before validation', async () => {
    mockRedis.incr.mockResolvedValue(11);

    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'admin@advika.com' });

    expect(res.status).toBe(429);
  });
});

describe('admin-only routes require auth', () => {
  it('401s GET /stats with no token', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
    expect(adminService.getAdminStats).not.toHaveBeenCalled();
  });

  it('403s GET /stats for a non-admin token', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
    expect(adminService.getAdminStats).not.toHaveBeenCalled();
  });

  it('200s GET /stats for a valid admin token', async () => {
    adminService.getAdminStats.mockResolvedValue({ totalUsers: 10 });

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ totalUsers: 10 });
  });

  it('401s GET /users with no token', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('422s GET /users with an out-of-range limit, even with a valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/users?limit=500')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(adminService.getAllUsersWithStats).not.toHaveBeenCalled();
  });

  it('422s GET /users with a search string over 100 chars', async () => {
    const res = await request(app)
      .get(`/api/admin/users?search=${'a'.repeat(101)}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(adminService.getAllUsersWithStats).not.toHaveBeenCalled();
  });

  it('200s GET /users for a valid admin token and valid query', async () => {
    adminService.getAllUsersWithStats.mockResolvedValue({
      data: [{ id: 'u1' }],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    const res = await request(app)
      .get('/api/admin/users?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'u1' }]);
  });

  it('200s GET /users with a search term for a valid admin token', async () => {
    adminService.getAllUsersWithStats.mockResolvedValue({
      data: [{ id: 'u1', name: 'Jane' }],
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    const res = await request(app)
      .get('/api/admin/users?search=jane')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(adminService.getAllUsersWithStats).toHaveBeenCalled();
  });
});

describe('GET /api/admin/users/:id', () => {
  const validId = '507f1f77bcf86cd799439011';

  it('401s with no token', async () => {
    const res = await request(app).get(`/api/admin/users/${validId}`);
    expect(res.status).toBe(401);
    expect(adminService.getUserDetailById).not.toHaveBeenCalled();
  });

  it('403s for a non-admin token', async () => {
    const res = await request(app)
      .get(`/api/admin/users/${validId}`)
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
    expect(adminService.getUserDetailById).not.toHaveBeenCalled();
  });

  it('422s on a malformed id, even with a valid admin token', async () => {
    const res = await request(app)
      .get('/api/admin/users/not-a-valid-id')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(422);
    expect(adminService.getUserDetailById).not.toHaveBeenCalled();
  });

  it('404s when the service reports no such user', async () => {
    adminService.getUserDetailById.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/admin/users/${validId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('200s for a valid admin token and a real user, without leaking a password field', async () => {
    adminService.getUserDetailById.mockResolvedValue({
      id: validId,
      name: 'Jane',
      email: 'jane@x.com',
      phone: '9876543210',
      role: 'customer',
      joinedOn: '2026-01-01T00:00:00.000Z',
      addresses: [],
      recentOrders: [],
      orderSummary: { totalOrders: 0, totalSpent: 0 },
    });

    const res = await request(app)
      .get(`/api/admin/users/${validId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(validId);
    expect(res.body.data.password).toBeUndefined();
  });
});
