const mockPrisma = {
  order: { aggregate: jest.fn(), count: jest.fn() },
  user: { count: jest.fn() },
  product: { count: jest.fn() },
  $runCommandRaw: jest.fn(),
};

jest.mock('@config/prisma', () => mockPrisma);

const analyticsService = require('@modules/admin/admin.analytics.service');

describe('admin.analytics.service', () => {
  describe('getAnalyticsOverview', () => {
    beforeEach(() => {
      mockPrisma.order.aggregate.mockReset();
      mockPrisma.order.count.mockReset();
      mockPrisma.user.count.mockReset();
      mockPrisma.product.count.mockReset();
    });

    it('computes gross revenue, AOV, and every count from independent backend queries', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 10000 } });
      mockPrisma.order.count
        .mockResolvedValueOnce(20) // paidOrderCount
        .mockResolvedValueOnce(25) // orderCount (non-draft)
        .mockResolvedValueOnce(18) // deliveredOrders
        .mockResolvedValueOnce(3); // pendingOrders
      mockPrisma.user.count.mockResolvedValue(15);
      mockPrisma.product.count.mockResolvedValue(40);

      const result = await analyticsService.getAnalyticsOverview({});

      expect(result.grossRevenue).toBe(10000);
      expect(result.paidOrderCount).toBe(20);
      expect(result.averageOrderValue).toBe(500); // 10000 / 20
      expect(result.orderCount).toBe(25);
      expect(result.deliveredOrders).toBe(18);
      expect(result.pendingOrders).toBe(3);
      expect(result.newCustomers).toBe(15);
      expect(result.totalActiveProducts).toBe(40);
      expect(result.range).toEqual({ from: null, to: null });
    });

    it('never divides by zero — AOV is 0 with no paid orders, not NaN/Infinity', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: null } });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.product.count.mockResolvedValue(0);

      const result = await analyticsService.getAnalyticsOverview({});

      expect(result.grossRevenue).toBe(0);
      expect(result.averageOrderValue).toBe(0);
      expect(Number.isFinite(result.averageOrderValue)).toBe(true);
    });

    it('never invents a profit/margin field', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 5000 } });
      mockPrisma.order.count.mockResolvedValue(1);
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.product.count.mockResolvedValue(1);

      const result = await analyticsService.getAnalyticsOverview({});

      expect(result.profit).toBeUndefined();
      expect(result.margin).toBeUndefined();
      expect(result.inventoryValuation).toBeUndefined();
    });

    it('ships a backend-authoritative definition for every KPI it returns', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 0 } });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.product.count.mockResolvedValue(0);

      const result = await analyticsService.getAnalyticsOverview({});

      [
        'grossRevenue',
        'paidOrderCount',
        'averageOrderValue',
        'orderCount',
        'deliveredOrders',
        'pendingOrders',
        'newCustomers',
        'totalActiveProducts',
      ].forEach((key) => {
        expect(typeof result.definitions[key]).toBe('string');
        expect(result.definitions[key].length).toBeGreaterThan(10);
      });
    });

    it('scopes every date-sensitive query to the resolved dateFrom/dateTo range, dateTo inclusive of the whole day', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 100 } });
      mockPrisma.order.count.mockResolvedValue(1);
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.product.count.mockResolvedValue(1);

      await analyticsService.getAnalyticsOverview({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      });

      const aggregateArgs = mockPrisma.order.aggregate.mock.calls[0][0];
      expect(aggregateArgs.where.createdAt.gte.toISOString()).toBe(
        '2026-01-01T00:00:00.000Z'
      );
      expect(aggregateArgs.where.createdAt.lte.getHours()).toBe(23);
      expect(aggregateArgs.where.createdAt.lte.getMinutes()).toBe(59);

      // Product count is deliberately NOT date-scoped — it's a live
      // catalog snapshot, not a range-bound query.
      const productArgs = mockPrisma.product.count.mock.calls[0][0];
      expect(productArgs).toEqual({ where: { isDeleted: false } });
    });

    it('excludes draft orders from orderCount, same convention as order.service.js', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { total: 0 } });
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.product.count.mockResolvedValue(0);

      await analyticsService.getAnalyticsOverview({});

      // Second order.count call (index 1) is orderCount.
      const orderCountArgs = mockPrisma.order.count.mock.calls[1][0];
      expect(orderCountArgs.where.status).toEqual({ not: 'draft' });
    });
  });

  describe('getRevenueTrend', () => {
    beforeEach(() => {
      mockPrisma.$runCommandRaw.mockReset();
    });

    it('runs a MongoDB-side aggregation pipeline scoped to paid orders in range', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: { firstBatch: [] },
      });

      await analyticsService.getRevenueTrend({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-07',
        granularity: 'day',
      });

      const callArg = mockPrisma.$runCommandRaw.mock.calls[0][0];
      expect(callArg.aggregate).toBe('Order');
      expect(callArg.pipeline[0].$match.paymentStatus).toBe('paid');
      expect(callArg.pipeline[0].$match.createdAt.$gte.toISOString()).toBe(
        '2026-01-01T00:00:00.000Z'
      );
    });

    it('maps raw aggregation buckets into revenue/orderCount/label/period fields', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: {
          firstBatch: [
            {
              _id: '2026-01-02',
              revenue: 4500,
              orderCount: 3,
              periodStart: { $date: '2026-01-02T04:00:00.000Z' },
              periodEnd: { $date: '2026-01-02T18:00:00.000Z' },
            },
          ],
        },
      });

      const result = await analyticsService.getRevenueTrend({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-07',
        granularity: 'day',
      });

      expect(result.buckets).toEqual([
        {
          label: '2026-01-02',
          periodStart: '2026-01-02T04:00:00.000Z',
          periodEnd: '2026-01-02T18:00:00.000Z',
          revenue: 4500,
          orderCount: 3,
        },
      ]);
    });

    it('labels week buckets from isoYear/isoWeek rather than a raw string id', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: {
          firstBatch: [
            {
              _id: { isoYear: 2026, isoWeek: 3 },
              revenue: 1000,
              orderCount: 1,
              periodStart: { $date: '2026-01-12T00:00:00.000Z' },
              periodEnd: { $date: '2026-01-12T00:00:00.000Z' },
            },
          ],
        },
      });

      const result = await analyticsService.getRevenueTrend({
        granularity: 'week',
      });

      expect(result.buckets[0].label).toBe('2026-W03');
    });

    it('defaults to a trailing 30-day window when no dates are given, and echoes the resolved range', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: { firstBatch: [] },
      });

      const result = await analyticsService.getRevenueTrend({});

      const from = new Date(result.range.from);
      const to = new Date(result.range.to);
      const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
      expect(diffDays).toBe(30); // trailing 30-day window: 00:00 on day 1 to 23:59:59.999 on day 30
    });

    it('falls back to day granularity for an invalid/unsupported value', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: { firstBatch: [] },
      });

      const result = await analyticsService.getRevenueTrend({
        granularity: 'yearly',
      });

      expect(result.granularity).toBe('day');
    });

    it('never fabricates a bucket for a period with no paid orders — buckets stay exactly what the DB returned', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: { firstBatch: [] },
      });

      const result = await analyticsService.getRevenueTrend({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      });

      expect(result.buckets).toEqual([]);
    });

    it('ships a backend-authoritative definition for revenue and orderCount', async () => {
      mockPrisma.$runCommandRaw.mockResolvedValue({
        cursor: { firstBatch: [] },
      });

      const result = await analyticsService.getRevenueTrend({});

      expect(typeof result.definitions.revenue).toBe('string');
      expect(typeof result.definitions.orderCount).toBe('string');
    });
  });
});
