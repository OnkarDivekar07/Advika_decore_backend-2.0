const mockPrisma = {
  user: { count: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  order: { count: jest.fn(), aggregate: jest.fn() },
  product: { count: jest.fn() },
};

jest.mock('@config/prisma', () => mockPrisma);

const mockRedis = { get: jest.fn(), set: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

const bcrypt = require('bcrypt');
const adminService = require('@modules/admin/admin.service');

describe('admin.service', () => {
  describe('getAdminStats', () => {
    beforeEach(() => {
      mockRedis.get.mockReset();
      mockRedis.set.mockReset();
      mockRedis.get.mockResolvedValue(null);
    });

    it('aggregates user/order/product counts and paid-order revenue', async () => {
      mockPrisma.user.count.mockResolvedValue(120);
      mockPrisma.order.count
        .mockResolvedValueOnce(50) // totalOrders (status: confirmed)
        .mockResolvedValueOnce(30) // deliveredOrders
        .mockResolvedValueOnce(5); // pendingOrders
      mockPrisma.product.count.mockResolvedValue(80);
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { total: 99999 },
      });

      const stats = await adminService.getAdminStats();

      expect(stats).toEqual({
        totalUsers: 120,
        totalOrders: 50,
        totalProducts: 80,
        deliveredOrders: 30,
        pendingOrders: 5,
        totalRevenue: 99999,
      });
    });

    it('falls back to 0 revenue when there are no paid orders yet', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.product.count.mockResolvedValue(0);
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { total: null },
      });

      const stats = await adminService.getAdminStats();
      expect(stats.totalRevenue).toBe(0);
    });

    // Pattern 22 (performance/caching): the dashboard's stats tile ran 6
    // uncached count/aggregate queries — 5 full-collection-style counts
    // plus an aggregate — on every single dashboard load, with no caching
    // layer despite every other hot read path in this codebase (product
    // listing, homepage, banners) already using one. These prove the same
    // Redis-backed, short-TTL, fail-open pattern now applies here too.
    it('serves a cache hit without querying the database at all', async () => {
      const cachedStats = {
        totalUsers: 7,
        totalOrders: 3,
        totalProducts: 9,
        deliveredOrders: 1,
        pendingOrders: 2,
        totalRevenue: 4321,
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedStats));

      const stats = await adminService.getAdminStats();

      expect(stats).toEqual(cachedStats);
      expect(mockPrisma.user.count).not.toHaveBeenCalled();
      expect(mockPrisma.order.count).not.toHaveBeenCalled();
      expect(mockPrisma.product.count).not.toHaveBeenCalled();
      expect(mockPrisma.order.aggregate).not.toHaveBeenCalled();
    });

    it('writes freshly computed stats to the cache with a short TTL on a cache miss', async () => {
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.product.count.mockResolvedValue(1);
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 500 } });

      await adminService.getAdminStats();
      // The cache write is deliberately fire-and-forget (same convention
      // as paginateWithCache.js) — give its microtask a tick to run before
      // asserting on it.
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl] = mockRedis.set.mock.calls[0];
      expect(typeof key).toBe('string');
      expect(JSON.parse(value)).toEqual({
        totalUsers: 1,
        totalOrders: 0,
        totalProducts: 1,
        deliveredOrders: 0,
        pendingOrders: 0,
        totalRevenue: 500,
      });
      expect(mode).toBe('EX');
      expect(ttl).toBeGreaterThan(0);
    });

    it('falls back to a live query when the cache read fails (e.g. Redis unreachable)', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));
      mockPrisma.user.count.mockResolvedValue(2);
      mockPrisma.order.count.mockResolvedValue(1);
      mockPrisma.product.count.mockResolvedValue(3);
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 10 } });

      const stats = await adminService.getAdminStats();

      expect(stats.totalUsers).toBe(2);
    });
  });

  describe('login', () => {
    it('rejects when no user exists for the given email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        adminService.login({ email: 'nobody@advika.com', password: 'x' })
      ).rejects.toMatchObject({
        message: 'Invalid email or password',
        statusCode: 401,
      });
    });

    it('rejects a non-admin account even with the right email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        role: 'customer',
        password: await bcrypt.hash('secret1', 4),
      });

      await expect(
        adminService.login({
          email: 'customer@advika.com',
          password: 'secret1',
        })
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rejects an incorrect password for a real admin account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'admin1',
        role: 'admin',
        name: 'Admin',
        email: 'admin@advika.com',
        password: await bcrypt.hash('correct-password', 4),
      });

      await expect(
        adminService.login({
          email: 'admin@advika.com',
          password: 'wrong-password',
        })
      ).rejects.toMatchObject({
        message: 'Invalid email or password',
        statusCode: 401,
      });
    });

    it('logs in a valid admin and returns a token plus a scoped user (no password hash leak)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'admin1',
        role: 'admin',
        name: 'Admin',
        email: 'admin@advika.com',
        password: await bcrypt.hash('correct-password', 4),
      });

      const result = await adminService.login({
        email: 'admin@advika.com',
        password: 'correct-password',
      });

      expect(result.user).toEqual({
        id: 'admin1',
        name: 'Admin',
        email: 'admin@advika.com',
        role: 'admin',
      });
      expect(result.user.password).toBeUndefined();
      expect(typeof result.token).toBe('string');
    });
  });

  describe('getAllUsersWithStats', () => {
    beforeEach(() => {
      mockRedis.get.mockReset();
      mockRedis.set.mockReset();
      mockPrisma.user.count.mockReset();
      mockPrisma.user.findMany.mockReset();
    });

    it('formats each user with computed order stats', async () => {
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          name: 'Jane',
          email: 'jane@x.com',
          phone: '9876543210',
          createdAt: new Date('2026-01-01'),
          addresses: [],
          orders: [
            { total: 100, createdAt: new Date('2026-01-02') },
            { total: 50, createdAt: new Date('2026-01-05') },
          ],
        },
      ]);

      const result = await adminService.getAllUsersWithStats({ query: {} });

      expect(result.data[0]).toMatchObject({
        id: 'u1',
        totalOrders: 2,
        totalSpent: 150,
      });
      expect(result.meta.total).toBe(1);
    });

    it('never hits the cache — admin.service explicitly disables caching for this listing', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await adminService.getAllUsersWithStats({ query: {} });

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('defaults to customers only when no ?role= filter is given', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await adminService.getAllUsersWithStats({ query: {} });

      const callArgs = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ role: 'customer' });
    });

    it('honors an explicit ?role= filter', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await adminService.getAllUsersWithStats({ query: { role: 'admin' } });

      const callArgs = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({ role: 'admin' });
    });

    it('selects role so it can be shown/filtered on in the panel', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await adminService.getAllUsersWithStats({ query: {} });

      const callArgs = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArgs.select.role).toBe(true);
    });

    it('wires ?search= into a name/email/phone OR-contains filter', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await adminService.getAllUsersWithStats({ query: { search: 'jane' } });

      const callArgs = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArgs.where.AND).toContainEqual({
        OR: [
          { name: { contains: 'jane', mode: 'insensitive' } },
          { email: { contains: 'jane', mode: 'insensitive' } },
          { phone: { contains: 'jane', mode: 'insensitive' } },
        ],
      });
    });

    it('never leaks a password field — formatUser is whitelist-only', async () => {
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          name: 'Jane',
          email: 'jane@x.com',
          phone: '9876543210',
          role: 'customer',
          password: 'should-never-appear',
          createdAt: new Date('2026-01-01'),
          addresses: [],
          orders: [],
        },
      ]);

      const result = await adminService.getAllUsersWithStats({ query: {} });

      expect(result.data[0].password).toBeUndefined();
    });

    it('summarizes to the default address when one is marked isDefault', async () => {
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          name: 'Jane',
          email: 'jane@x.com',
          phone: '9876543210',
          role: 'customer',
          createdAt: new Date('2026-01-01'),
          addresses: [
            { city: 'Mumbai', isDefault: false },
            { city: 'Pune', isDefault: true },
          ],
          orders: [],
        },
      ]);

      const result = await adminService.getAllUsersWithStats({ query: {} });

      expect(result.data[0].addressSummary).toEqual({ city: 'Pune' });
    });
  });

  describe('getUserDetailById', () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockReset();
      mockPrisma.order.aggregate.mockReset();
    });

    it('returns null when no user exists for the given id (controller maps this to 404)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.order.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { total: null },
      });

      const result = await adminService.getUserDetailById('nonexistent');
      expect(result).toBeNull();
    });

    it('combines the profile, addresses, recent orders, and a full-history order summary', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'Jane',
        email: 'jane@x.com',
        phone: '9876543210',
        role: 'customer',
        createdAt: new Date('2026-01-01'),
        addresses: [{ id: 'a1', city: 'Pune', isDefault: true }],
        orders: [
          {
            id: 'o1',
            status: 'delivered',
            paymentStatus: 'paid',
            total: 500,
            createdAt: new Date('2026-02-01'),
          },
        ],
      });
      mockPrisma.order.aggregate.mockResolvedValue({
        _count: { _all: 42 },
        _sum: { total: 99999 },
      });

      const result = await adminService.getUserDetailById('u1');

      expect(result.id).toBe('u1');
      expect(result.password).toBeUndefined();
      expect(result.addresses).toEqual([
        { id: 'a1', city: 'Pune', isDefault: true },
      ]);
      expect(result.recentOrders).toEqual([
        {
          id: 'o1',
          status: 'delivered',
          paymentStatus: 'paid',
          total: 500,
          createdAt: new Date('2026-02-01'),
        },
      ]);
      // orderSummary comes from the full aggregate, not just recentOrders.length
      expect(result.orderSummary).toEqual({
        totalOrders: 42,
        totalSpent: 99999,
      });
    });

    it('falls back to 0 totalSpent when the customer has no paid orders', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        name: 'Jane',
        email: 'jane@x.com',
        phone: '9',
        role: 'customer',
        createdAt: new Date(),
        addresses: [],
        orders: [],
      });
      mockPrisma.order.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { total: null },
      });

      const result = await adminService.getUserDetailById('u1');
      expect(result.orderSummary).toEqual({ totalOrders: 0, totalSpent: 0 });
    });
  });
});
