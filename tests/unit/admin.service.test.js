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
  });

  describe('login', () => {
    it('rejects when no user exists for the given email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        adminService.login({ email: 'nobody@advika.com', password: 'x' })
      ).rejects.toMatchObject({
        message: 'Invalid email or not an admin',
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
        adminService.login({ email: 'customer@advika.com', password: 'secret1' })
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
        message: 'Incorrect password',
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
  });
});
