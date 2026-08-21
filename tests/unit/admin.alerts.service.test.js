const mockPrisma = {
  order: { count: jest.fn(), findMany: jest.fn() },
  shipment: { count: jest.fn(), findMany: jest.fn() },
};

jest.mock('@config/prisma', () => mockPrisma);

// admin.service.js reuses inventory.service.js's listLowStockProducts
// rather than re-implementing the low-stock query — mocked here so this
// suite tests the aggregation, not inventory.service.js's own Prisma
// query (covered separately by inventory.service.js's own tests).
const mockListLowStockProducts = jest.fn();
jest.mock('@modules/inventory/inventory.service', () => ({
  listLowStockProducts: (...args) => mockListLowStockProducts(...args),
}));

const adminService = require('@modules/admin/admin.service');

describe('admin.service.getOperationalAlerts', () => {
  beforeEach(() => {
    mockPrisma.order.count.mockReset();
    mockPrisma.order.findMany.mockReset();
    mockPrisma.shipment.count.mockReset();
    mockPrisma.shipment.findMany.mockReset();
    mockListLowStockProducts.mockReset();
  });

  const stubEmpty = () => {
    mockListLowStockProducts.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.shipment.count.mockResolvedValue(0);
    mockPrisma.shipment.findMany.mockResolvedValue([]);
  };

  it('returns real zero counts and empty item lists when nothing needs attention — never fake rows', async () => {
    stubEmpty();

    const result = await adminService.getOperationalAlerts();

    expect(result.lowStock).toEqual({ threshold: 10, count: 0, items: [] });
    expect(result.pendingOrders).toEqual({ count: 0, items: [] });
    expect(result.paymentExceptions).toEqual({ count: 0, items: [] });
    expect(result.shipmentExceptions).toEqual({ count: 0, items: [] });
    expect(typeof result.generatedAt).toBe('string');
  });

  it('passes the given lowStockThreshold straight through to inventory.service, and reports it back', async () => {
    stubEmpty();

    const result = await adminService.getOperationalAlerts({ lowStockThreshold: 3 });

    expect(mockListLowStockProducts).toHaveBeenCalledWith(3);
    expect(result.lowStock.threshold).toBe(3);
  });

  it('defaults the low-stock threshold to 10 when none is given', async () => {
    stubEmpty();

    await adminService.getOperationalAlerts();

    expect(mockListLowStockProducts).toHaveBeenCalledWith(10);
  });

  it('surfaces real low-stock products exactly as inventory.service returns them', async () => {
    stubEmpty();
    mockListLowStockProducts.mockResolvedValue([
      { id: 'p1', name: 'Wall Clock', brand: 'Advika', stock: 2 },
    ]);

    const result = await adminService.getOperationalAlerts();

    expect(result.lowStock.count).toBe(1);
    expect(result.lowStock.items).toEqual([
      { id: 'p1', name: 'Wall Clock', brand: 'Advika', stock: 2 },
    ]);
  });

  it('queries pending orders by real status: pending, oldest first', async () => {
    stubEmpty();
    mockPrisma.order.count.mockResolvedValue(5);
    mockPrisma.order.findMany.mockResolvedValueOnce([
      { id: 'o1', total: 200, createdAt: new Date('2026-01-01'), user: { name: 'Jane', email: 'jane@x.com' } },
    ]);

    const result = await adminService.getOperationalAlerts();

    expect(mockPrisma.order.count).toHaveBeenCalledWith({ where: { status: 'pending' } });
    const findManyCall = mockPrisma.order.findMany.mock.calls.find(
      (call) => call[0].where.status === 'pending'
    );
    expect(findManyCall[0].orderBy).toEqual({ createdAt: 'asc' });
    expect(result.pendingOrders.count).toBe(5);
    expect(result.pendingOrders.items).toEqual([
      { id: 'o1', total: 200, createdAt: new Date('2026-01-01'), user: { name: 'Jane', email: 'jane@x.com' } },
    ]);
  });

  it('falls back to N/A / null when a pending order has no joined user', async () => {
    stubEmpty();
    mockPrisma.order.findMany.mockResolvedValueOnce([
      { id: 'o1', total: 200, createdAt: new Date('2026-01-01'), user: null },
    ]);

    const result = await adminService.getOperationalAlerts();

    expect(result.pendingOrders.items[0].user).toEqual({ name: 'N/A', email: null });
  });

  it('queries payment exceptions as only failed/timeout/unknown — never pending/attempted/paid/cancelled', async () => {
    stubEmpty();
    mockPrisma.order.count.mockResolvedValue(2);
    mockPrisma.order.findMany
      .mockResolvedValueOnce([]) // pending orders list
      .mockResolvedValueOnce([
        {
          id: 'o2',
          total: 400,
          paymentStatus: 'failed',
          createdAt: new Date('2026-02-01'),
          user: { name: 'Sam', email: 'sam@x.com' },
        },
      ]);

    const result = await adminService.getOperationalAlerts();

    const findManyCall = mockPrisma.order.findMany.mock.calls.find(
      (call) => call[0].where.paymentStatus
    );
    expect(findManyCall[0].where.paymentStatus).toEqual({ in: ['failed', 'timeout', 'unknown'] });
    expect(findManyCall[0].orderBy).toEqual({ createdAt: 'desc' });
    expect(result.paymentExceptions.items).toEqual([
      {
        id: 'o2',
        total: 400,
        paymentStatus: 'failed',
        createdAt: new Date('2026-02-01'),
        user: { name: 'Sam', email: 'sam@x.com' },
      },
    ]);
  });

  it('queries shipment exceptions as only DELIVERY_FAILED/RTO_INITIATED — never CREATED/DELIVERED/RTO_DELIVERED/CANCELLED', async () => {
    stubEmpty();
    mockPrisma.shipment.count.mockResolvedValue(1);
    mockPrisma.shipment.findMany.mockResolvedValueOnce([
      {
        orderId: 'o3',
        trackingId: 'TRK1',
        status: 'DELIVERY_FAILED',
        courierPartner: 'Ekart',
        lastLocation: 'Pune Hub',
        updatedAt: new Date('2026-03-01'),
      },
    ]);
    mockPrisma.order.findMany
      .mockResolvedValueOnce([]) // pending
      .mockResolvedValueOnce([]) // payment exceptions
      .mockResolvedValueOnce([
        { id: 'o3', total: 900, user: { name: 'Priya', email: 'priya@x.com' } },
      ]); // related-orders batch join

    const result = await adminService.getOperationalAlerts();

    const shipmentCall = mockPrisma.shipment.findMany.mock.calls[0][0];
    expect(shipmentCall.where.status).toEqual({ in: ['DELIVERY_FAILED', 'RTO_INITIATED'] });
    expect(result.shipmentExceptions.count).toBe(1);
    expect(result.shipmentExceptions.items).toEqual([
      {
        orderId: 'o3',
        trackingId: 'TRK1',
        status: 'DELIVERY_FAILED',
        courierPartner: 'Ekart',
        lastLocation: 'Pune Hub',
        updatedAt: new Date('2026-03-01'),
        total: 900,
        user: { name: 'Priya', email: 'priya@x.com' },
      },
    ]);
  });

  it('never queries the related-orders batch join when there are no shipment exceptions', async () => {
    stubEmpty();

    await adminService.getOperationalAlerts();

    // Only the pending-orders and payment-exceptions findMany calls should
    // have run — no third order.findMany for a batch join that has
    // nothing to join.
    expect(mockPrisma.order.findMany).toHaveBeenCalledTimes(2);
  });

  it('reports total: null and user: null for a shipment exception whose order could not be found', async () => {
    stubEmpty();
    mockPrisma.shipment.findMany.mockResolvedValueOnce([
      {
        orderId: 'ghost-order',
        trackingId: null,
        status: 'RTO_INITIATED',
        courierPartner: 'Ekart',
        lastLocation: null,
        updatedAt: new Date('2026-03-01'),
      },
    ]);
    mockPrisma.order.findMany
      .mockResolvedValueOnce([]) // pending
      .mockResolvedValueOnce([]) // payment exceptions
      .mockResolvedValueOnce([]); // related-orders batch join finds nothing

    const result = await adminService.getOperationalAlerts();

    expect(result.shipmentExceptions.items[0].total).toBeNull();
    expect(result.shipmentExceptions.items[0].user).toBeNull();
  });
});
