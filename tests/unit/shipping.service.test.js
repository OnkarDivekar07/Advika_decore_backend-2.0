// Ekart client: never hit the network. Mocked via the same relative path
// shipping.service.js itself uses to require it — Jest matches mocks by
// resolved absolute path, so this lines up regardless of the differing
// relative path string from this test file. Same pattern as
// payment.service.test.js mocking clearCartQueue.
jest.mock('../../src/services/external/EkartClient', () => ({
  checkServiceability: jest.fn(),
  createShipment: jest.fn(),
  trackShipment: jest.fn(),
  cancelShipment: jest.fn(),
  updateShipment: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

const mockOrder = { findUnique: jest.fn(), update: jest.fn() };
const mockShipment = { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() };

jest.mock('@config/prisma', () => ({
  order: mockOrder,
  shipment: mockShipment,
}));

const ekartClient = require('../../src/services/external/EkartClient');
const shippingService = require('@modules/shipping/shipping.service');

const baseOrder = {
  id: 'order_1',
  userId: 'user_1',
  status: 'confirmed',
  paymentStatus: 'paid',
  total: 999,
  address: {
    name: 'Jane Doe',
    phone: '9999999999',
    houseArea: '221B Baker Street',
    landmark: null,
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400001',
  },
  orderItems: [
    { productId: 'p1', quantity: 2, price: 250, product: { name: 'Mug', weightKg: 0.3 } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkServiceability', () => {
  it('normalizes the Ekart response into a stable shape', async () => {
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      sla_days: 3,
      cod_available: true,
    });

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
      paymentMode: 'COD',
    });

    expect(result).toEqual({
      serviceable: true,
      estimatedDays: 3,
      codAvailable: true,
    });
  });

  it('defaults to not serviceable when the fields are missing', async () => {
    ekartClient.checkServiceability.mockResolvedValue({});

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: false,
      estimatedDays: null,
      codAvailable: false,
    });
  });
});

describe('createShipmentForOrder', () => {
  it('throws a 404 if the order does not exist', async () => {
    mockOrder.findUnique.mockResolvedValue(null);

    await expect(shippingService.createShipmentForOrder('order_1')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(ekartClient.createShipment).not.toHaveBeenCalled();
  });

  it("throws a 400 if the order isn't confirmed yet", async () => {
    mockOrder.findUnique.mockResolvedValue({ ...baseOrder, status: 'draft' });

    await expect(shippingService.createShipmentForOrder('order_1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ekartClient.createShipment).not.toHaveBeenCalled();
  });

  it('is idempotent — returns the existing shipment without calling Ekart again', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({ id: 'shipment_1', orderId: 'order_1' });

    const result = await shippingService.createShipmentForOrder('order_1');

    expect(result.alreadyProcessed).toBe(true);
    expect(ekartClient.createShipment).not.toHaveBeenCalled();
    expect(mockShipment.create).not.toHaveBeenCalled();
  });

  it('creates a shipment with Ekart, persists it, and marks the order shipped', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    ekartClient.createShipment.mockResolvedValue({
      tracking_id: 'EKT123',
      awb_number: 'AWB123',
    });
    mockShipment.create.mockResolvedValue({
      id: 'shipment_1',
      orderId: 'order_1',
      trackingId: 'EKT123',
    });

    const result = await shippingService.createShipmentForOrder('order_1');

    expect(result.alreadyProcessed).toBe(false);
    expect(ekartClient.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: 'order_1',
        payment_mode: 'PREPAID',
        cod_amount: 0,
        consignee: expect.objectContaining({ pincode: '400001' }),
        weight: 0.6, // 0.3kg * quantity 2
      })
    );
    expect(mockShipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order_1',
          trackingId: 'EKT123',
          awbNumber: 'AWB123',
          status: 'CREATED',
        }),
      })
    );
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'shipped' },
    });
  });

  it('marks a COD order with the full order total as the COD amount', async () => {
    mockOrder.findUnique.mockResolvedValue({ ...baseOrder, paymentStatus: 'cod_pending' });
    mockShipment.findUnique.mockResolvedValue(null);
    ekartClient.createShipment.mockResolvedValue({ tracking_id: 'EKT123' });
    mockShipment.create.mockResolvedValue({ id: 'shipment_1' });

    await shippingService.createShipmentForOrder('order_1');

    expect(ekartClient.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({ payment_mode: 'COD', cod_amount: 999 })
    );
  });
});

describe('trackOrderShipment', () => {
  const requestingOwner = { userId: 'user_1', role: 'customer' };
  const requestingOther = { userId: 'someone_else', role: 'customer' };
  const requestingAdmin = { userId: 'admin_1', role: 'admin' };

  it('throws a 404 if the order does not exist', async () => {
    mockOrder.findUnique.mockResolvedValue(null);

    await expect(
      shippingService.trackOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws a 403 if the requester doesn't own the order and isn't an admin", async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);

    await expect(
      shippingService.trackOrderShipment('order_1', requestingOther)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockShipment.findUnique).not.toHaveBeenCalled();
  });

  it('allows an admin to track a shipment on someone else\'s order', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'CREATED',
    });
    ekartClient.trackShipment.mockResolvedValue({ status: 'IN_TRANSIT' });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'IN_TRANSIT' });

    const result = await shippingService.trackOrderShipment('order_1', requestingAdmin);

    expect(result.status).toBe('IN_TRANSIT');
  });

  it('throws a 404 if no shipment exists yet for the order', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);

    await expect(
      shippingService.trackOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the shipment as-is if Ekart has not yet returned a tracking id', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({ orderId: 'order_1', trackingId: null, status: 'CREATED' });

    const result = await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(result).toEqual({ orderId: 'order_1', trackingId: null, status: 'CREATED' });
    expect(ekartClient.trackShipment).not.toHaveBeenCalled();
  });

  it('polls Ekart, updates the shipment, and syncs the order to delivered', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'OUT_FOR_DELIVERY',
    });
    ekartClient.trackShipment.mockResolvedValue({
      status: 'DELIVERED',
      current_location: 'Mumbai Hub',
    });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'DELIVERED' });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: expect.objectContaining({ status: 'DELIVERED', lastLocation: 'Mumbai Hub' }),
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'delivered' },
    });
  });

  it('does not touch the order for a non-terminal status like IN_TRANSIT', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({ orderId: 'order_1', trackingId: 'EKT123' });
    ekartClient.trackShipment.mockResolvedValue({ status: 'IN_TRANSIT' });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'IN_TRANSIT' });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockOrder.update).not.toHaveBeenCalled();
  });
});

describe('cancelOrderShipment', () => {
  const requestingOwner = { userId: 'user_1', role: 'customer' };
  const requestingOther = { userId: 'someone_else', role: 'customer' };

  it('throws a 404 if the order does not exist', async () => {
    mockOrder.findUnique.mockResolvedValue(null);

    await expect(
      shippingService.cancelOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws a 403 if the requester doesn't own the order and isn't an admin", async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);

    await expect(
      shippingService.cancelOrderShipment('order_1', requestingOther)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('throws a 400 if the shipment is already in a terminal state', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({ orderId: 'order_1', status: 'DELIVERED' });

    await expect(
      shippingService.cancelOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ekartClient.cancelShipment).not.toHaveBeenCalled();
  });

  it('cancels with Ekart and updates both the shipment and the order', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'CREATED',
    });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'CANCELLED' });

    const result = await shippingService.cancelOrderShipment('order_1', requestingOwner, 'Changed my mind');

    expect(ekartClient.cancelShipment).toHaveBeenCalledWith('EKT123', 'Changed my mind');
    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: { status: 'CANCELLED' },
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'cancelled' },
    });
    expect(result.status).toBe('CANCELLED');
  });

  it('skips the Ekart call if no tracking id was ever assigned', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({ orderId: 'order_1', trackingId: null, status: 'CREATED' });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'CANCELLED' });

    await shippingService.cancelOrderShipment('order_1', requestingOwner);

    expect(ekartClient.cancelShipment).not.toHaveBeenCalled();
  });
});

describe('handleEkartWebhookEvent', () => {
  it('ignores events with no tracking id (nothing to reconcile)', async () => {
    await shippingService.handleEkartWebhookEvent({ status: 'DELIVERED' });

    expect(mockShipment.findUnique).not.toHaveBeenCalled();
  });

  it('warns and no-ops on a tracking id it does not recognize', async () => {
    mockShipment.findUnique.mockResolvedValue(null);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await shippingService.handleEkartWebhookEvent({ tracking_id: 'UNKNOWN', status: 'DELIVERED' });

    expect(mockShipment.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('updates the shipment and syncs the order on a recognized delivery event', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'OUT_FOR_DELIVERY',
    });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'DELIVERED' });

    await shippingService.handleEkartWebhookEvent({
      tracking_id: 'EKT123',
      status: 'DELIVERED',
      current_location: 'Mumbai Hub',
    });

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { trackingId: 'EKT123' },
      data: expect.objectContaining({ status: 'DELIVERED' }),
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'delivered' },
    });
  });

  it('maps an RTO_DELIVERED event to a returned order', async () => {
    mockShipment.findUnique.mockResolvedValue({ orderId: 'order_1', trackingId: 'EKT123' });
    mockShipment.update.mockResolvedValue({ orderId: 'order_1', status: 'RTO_DELIVERED' });

    await shippingService.handleEkartWebhookEvent({
      tracking_id: 'EKT123',
      status: 'RTO_DELIVERED',
    });

    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'returned' },
    });
  });
});
