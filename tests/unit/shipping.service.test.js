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
const mockShipment = {
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

jest.mock('@config/prisma', () => ({
  order: mockOrder,
  shipment: mockShipment,
}));

const ekartClient = require('../../src/services/external/EkartClient');
const shippingService = require('@modules/shipping/shipping.service');
const logger = require('@config/logger');

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
    {
      productId: 'p1',
      quantity: 2,
      price: 250,
      product: { name: 'Mug', weightKg: 0.3 },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getDeliveryConfig', () => {
  it('mirrors the configured pricing constants', () => {
    const {
      FREE_DELIVERY_THRESHOLD,
      DELIVERY_CHARGE,
    } = require('@constants/pricing');

    expect(shippingService.getDeliveryConfig()).toEqual({
      freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
      deliveryCharge: DELIVERY_CHARGE,
    });
  });
});

describe('checkServiceability', () => {
  it('normalizes the Ekart response into a stable shape, including a computed delivery date', async () => {
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      sla_days: 3,
      cod_available: true,
    });

    const before = Date.now();
    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
      paymentMode: 'COD',
    });
    const after = Date.now();

    expect(result).toMatchObject({
      serviceable: true,
      reason: null,
      estimatedDays: 3,
      codAvailable: true,
    });
    expect(result.estimatedDeliveryDate).toBeInstanceOf(Date);
    // Roughly "3 days from now" — bounded rather than asserting an exact
    // timestamp, since addDays() reads the current time internally.
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    expect(result.estimatedDeliveryDate.getTime()).toBeGreaterThanOrEqual(
      before + THREE_DAYS_MS - 1000
    );
    expect(result.estimatedDeliveryDate.getTime()).toBeLessThanOrEqual(
      after + THREE_DAYS_MS + 1000
    );
  });

  it('defaults to not serviceable when the fields are missing, with no delivery date to show', async () => {
    ekartClient.checkServiceability.mockResolvedValue({});

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: false,
      reason: 'AREA_NOT_COVERED',
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: false,
    });
  });

  it('withholds a delivery date for a serviceable pincode with no day-count SLA', async () => {
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      cod_available: false,
    });

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result.estimatedDays).toBeNull();
    expect(result.estimatedDeliveryDate).toBeNull();
  });

  it('reports INVALID_PINCODE (not a generic error) when Ekart says the pincode is unrecognized', async () => {
    const ekartError = new Error('Invalid pincode supplied');
    ekartError.statusCode = 400;
    ekartClient.checkServiceability.mockRejectedValue(ekartError);

    const result = await shippingService.checkServiceability({
      destinationPincode: '999999',
    });

    expect(result).toEqual({
      serviceable: false,
      reason: 'INVALID_PINCODE',
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: false,
    });
  });

  it('throws a 503 (not a generic 500) when Ekart times out rather than giving a real answer', async () => {
    const timeoutError = new Error('Ekart API request timed out after 8000ms');
    timeoutError.isTimeout = true;
    ekartClient.checkServiceability.mockRejectedValue(timeoutError);

    await expect(
      shippingService.checkServiceability({ destinationPincode: '400001' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('throws a 503 when Ekart errors in a way that does not match the invalid-pincode heuristic', async () => {
    const serverError = new Error('Internal Server Error');
    serverError.statusCode = 500;
    ekartClient.checkServiceability.mockRejectedValue(serverError);

    await expect(
      shippingService.checkServiceability({ destinationPincode: '400001' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('checkDeliveryEligibility', () => {
  it('passes through a definitive serviceable result', async () => {
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      cod_available: true,
    });

    const result = await shippingService.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result).toMatchObject({
      serviceable: true,
      skippedCheck: undefined,
    });
  });

  it('passes through a definitive not-serviceable result so callers can block on it', async () => {
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: false,
    });

    const result = await shippingService.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result.serviceable).toBe(false);
    expect(result.reason).toBe('AREA_NOT_COVERED');
  });

  it('fails open (does not block) when the check itself could not get an answer, under the default policy', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.isTimeout = true;
    ekartClient.checkServiceability.mockRejectedValue(timeoutError);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await shippingService.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: true,
      reason: null,
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: true,
      skippedCheck: true,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_closed — a separate describe
// block that loads its own fresh copy of shipping.service.js (and its
// EkartClient mock) under the overridden env var, rather than sharing the
// module instance the rest of this file uses, since the policy is read
// once at require time (see src/config/env.js / shipping.service.js's own
// top-of-file require). Same isolated-reload pattern as
// env.deliveryPricing.test.js.
describe('checkDeliveryEligibility — SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_closed', () => {
  const ORIGINAL_ENV = { ...process.env };
  let ekartClientFailClosed;
  let shippingServiceFailClosed;
  let loggerFailClosed;

  beforeEach(() => {
    jest.resetModules();
    process.env.SHIPPING_SERVICEABILITY_FALLBACK_POLICY = 'fail_closed';

    jest.doMock('../../src/services/external/EkartClient', () => ({
      checkServiceability: jest.fn(),
      createShipment: jest.fn(),
      trackShipment: jest.fn(),
      cancelShipment: jest.fn(),
      updateShipment: jest.fn(),
      verifyWebhookSignature: jest.fn(),
    }));
    jest.doMock('@config/prisma', () => ({
      order: { findUnique: jest.fn(), update: jest.fn() },
      shipment: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    }));

    // eslint-disable-next-line global-require
    ekartClientFailClosed = require('../../src/services/external/EkartClient');
    // eslint-disable-next-line global-require
    shippingServiceFailClosed = require('@modules/shipping/shipping.service');
    // jest.resetModules() above means shipping.service.js's own internal
    // require('@config/logger') resolves to a fresh module instance, not
    // the one this file's top-level `logger` const captured before any
    // reset — spying on that stale instance would never see the call this
    // fresh shippingServiceFailClosed actually makes.
    // eslint-disable-next-line global-require
    loggerFailClosed = require('@config/logger');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('blocks (serviceable: false, reason CHECK_UNAVAILABLE) when the check could not get an answer', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.isTimeout = true;
    ekartClientFailClosed.checkServiceability.mockRejectedValue(timeoutError);
    const warnSpy = jest
      .spyOn(loggerFailClosed, 'warn')
      .mockImplementation(() => {});

    const result = await shippingServiceFailClosed.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: false,
      reason: 'CHECK_UNAVAILABLE',
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: false,
      skippedCheck: true,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still passes through a definitive answer unchanged (policy only governs the failure path)', async () => {
    ekartClientFailClosed.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      cod_available: true,
    });

    const result = await shippingServiceFailClosed.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result).toMatchObject({
      serviceable: true,
      skippedCheck: undefined,
    });
  });
});

describe('checkServiceability — pincode format', () => {
  it.each([
    ['', 'an empty string'],
    ['   ', 'whitespace only'],
    ['12345', 'too short'],
    ['1234567', 'too long'],
    ['012345', 'a leading zero (not a real Indian pincode)'],
    ['abcdef', 'non-numeric'],
    [undefined, 'missing entirely'],
    [null, 'null'],
  ])(
    'rejects %s (%s) as INVALID_FORMAT without calling Ekart',
    async (badPincode) => {
      const result = await shippingService.checkServiceability({
        destinationPincode: badPincode,
      });

      expect(result).toEqual({
        serviceable: false,
        reason: 'INVALID_FORMAT',
        estimatedDays: null,
        estimatedDeliveryDate: null,
        codAvailable: false,
      });
      expect(ekartClient.checkServiceability).not.toHaveBeenCalled();
    }
  );

  it('proceeds to call Ekart for a well-formed pincode', async () => {
    ekartClient.checkServiceability.mockResolvedValue({ is_serviceable: true });

    await shippingService.checkServiceability({ destinationPincode: '400001' });

    expect(ekartClient.checkServiceability).toHaveBeenCalled();
  });
});

describe('checkServiceability — normalized pricing contract (subtotal)', () => {
  it('omits deliveryCharge/freeDeliveryThreshold/freeDeliveryEligible when no subtotal is given', async () => {
    ekartClient.checkServiceability.mockResolvedValue({ is_serviceable: true });

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result).not.toHaveProperty('deliveryCharge');
    expect(result).not.toHaveProperty('freeDeliveryThreshold');
    expect(result).not.toHaveProperty('freeDeliveryEligible');
  });

  it('folds in the delivery-charge/free-delivery fields for a given subtotal, using the same rule as order/cart totals', async () => {
    const {
      FREE_DELIVERY_THRESHOLD,
      DELIVERY_CHARGE,
    } = require('@constants/pricing');
    ekartClient.checkServiceability.mockResolvedValue({
      is_serviceable: true,
      cod_available: true,
    });

    const belowThreshold = await shippingService.checkServiceability({
      destinationPincode: '400001',
      subtotal: FREE_DELIVERY_THRESHOLD - 1,
    });
    expect(belowThreshold).toMatchObject({
      deliveryCharge: DELIVERY_CHARGE,
      freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
      freeDeliveryEligible: false,
    });

    const atThreshold = await shippingService.checkServiceability({
      destinationPincode: '400001',
      subtotal: FREE_DELIVERY_THRESHOLD,
    });
    expect(atThreshold).toMatchObject({
      deliveryCharge: 0,
      freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
      freeDeliveryEligible: true,
    });
  });

  it('also prices an INVALID_FORMAT/unserviceable result rather than only the happy path', async () => {
    const { DELIVERY_CHARGE } = require('@constants/pricing');

    const result = await shippingService.checkServiceability({
      destinationPincode: 'bad',
      subtotal: 0,
    });

    expect(result).toMatchObject({
      serviceable: false,
      reason: 'INVALID_FORMAT',
      deliveryCharge: DELIVERY_CHARGE,
      freeDeliveryEligible: false,
    });
  });
});

describe('createShipmentForOrder', () => {
  it('throws a 404 if the order does not exist', async () => {
    mockOrder.findUnique.mockResolvedValue(null);

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(ekartClient.createShipment).not.toHaveBeenCalled();
  });

  it("throws a 400 if the order isn't confirmed yet", async () => {
    mockOrder.findUnique.mockResolvedValue({ ...baseOrder, status: 'draft' });

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(ekartClient.createShipment).not.toHaveBeenCalled();
  });

  it('is idempotent — returns the existing shipment without calling Ekart again', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      id: 'shipment_1',
      orderId: 'order_1',
    });

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
      estimated_delivery_days: 4,
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
          estimatedDeliveryDate: expect.any(Date),
        }),
      })
    );
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'shipped' },
    });
  });

  it('marks a COD order with the full order total as the COD amount', async () => {
    mockOrder.findUnique.mockResolvedValue({
      ...baseOrder,
      paymentStatus: 'cod_pending',
    });
    mockShipment.findUnique.mockResolvedValue(null);
    ekartClient.createShipment.mockResolvedValue({ tracking_id: 'EKT123' });
    mockShipment.create.mockResolvedValue({ id: 'shipment_1' });

    await shippingService.createShipmentForOrder('order_1');

    expect(ekartClient.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({ payment_mode: 'COD', cod_amount: 999 })
    );
  });

  it('surfaces a clean 422 (not a raw Ekart error) if the pincode has fallen out of coverage since the order was confirmed', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    const ekartError = new Error('Invalid pincode');
    ekartError.statusCode = 400;
    ekartClient.createShipment.mockRejectedValue(ekartError);

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mockShipment.create).not.toHaveBeenCalled();
  });

  it('surfaces a 503 if Ekart is unreachable while creating the shipment', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    const timeoutError = new Error('timed out');
    timeoutError.isTimeout = true;
    ekartClient.createShipment.mockRejectedValue(timeoutError);

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 503,
    });
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

  it("allows an admin to track a shipment on someone else's order", async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'CREATED',
    });
    ekartClient.trackShipment.mockResolvedValue({ status: 'IN_TRANSIT' });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'IN_TRANSIT',
    });

    const result = await shippingService.trackOrderShipment(
      'order_1',
      requestingAdmin
    );

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
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: null,
      status: 'CREATED',
    });

    const result = await shippingService.trackOrderShipment(
      'order_1',
      requestingOwner
    );

    expect(result).toEqual({
      orderId: 'order_1',
      trackingId: null,
      status: 'CREATED',
    });
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
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'DELIVERED',
    });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: expect.objectContaining({
        status: 'DELIVERED',
        lastLocation: 'Mumbai Hub',
      }),
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'delivered' },
    });
  });

  it('does not touch the order for a non-terminal status like IN_TRANSIT', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
    });
    ekartClient.trackShipment.mockResolvedValue({ status: 'IN_TRANSIT' });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'IN_TRANSIT',
    });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockOrder.update).not.toHaveBeenCalled();
  });

  it('keeps the previously stored estimate when a poll has nothing new to say about timing', async () => {
    const existingEstimate = new Date('2026-08-20T00:00:00.000Z');
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'IN_TRANSIT',
      estimatedDeliveryDate: existingEstimate,
    });
    ekartClient.trackShipment.mockResolvedValue({ status: 'IN_TRANSIT' });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'IN_TRANSIT',
    });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: expect.objectContaining({
        estimatedDeliveryDate: existingEstimate,
      }),
    });
  });

  it('adopts a revised delivery date when a poll returns one', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
      status: 'IN_TRANSIT',
      estimatedDeliveryDate: new Date('2026-08-20T00:00:00.000Z'),
    });
    ekartClient.trackShipment.mockResolvedValue({
      status: 'IN_TRANSIT',
      expected_delivery_date: '2026-08-25T00:00:00.000Z',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'IN_TRANSIT',
    });

    await shippingService.trackOrderShipment('order_1', requestingOwner);

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: expect.objectContaining({
        estimatedDeliveryDate: new Date('2026-08-25T00:00:00.000Z'),
      }),
    });
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
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      status: 'DELIVERED',
    });

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
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'CANCELLED',
    });

    const result = await shippingService.cancelOrderShipment(
      'order_1',
      requestingOwner,
      'Changed my mind'
    );

    expect(ekartClient.cancelShipment).toHaveBeenCalledWith(
      'EKT123',
      'Changed my mind'
    );
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
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: null,
      status: 'CREATED',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'CANCELLED',
    });

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
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await shippingService.handleEkartWebhookEvent({
      tracking_id: 'UNKNOWN',
      status: 'DELIVERED',
    });

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
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'DELIVERED',
    });

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
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'EKT123',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'RTO_DELIVERED',
    });

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
