// Delhivery client: never hit the network. Mocked via the same relative
// path shipping.service.js itself uses to require it — Jest matches mocks
// by resolved absolute path, so this lines up regardless of the differing
// relative path string from this test file. Same pattern as
// payment.service.test.js mocking clearCartQueue.
jest.mock('../../src/services/external/DelhiveryClient', () => ({
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

// inventory.service is a real cross-module dependency (cancelOrderShipment
// restores stock through it) — mocked at the service level rather than
// reaching into a Prisma `product` double here, same convention other test
// files use for this module (e.g. order.service.test.js mocking
// shippingService).
const mockInventoryService = { restoreStockForOrder: jest.fn() };
jest.mock('@modules/inventory/inventory.service', () => mockInventoryService);

const delhiveryClient = require('../../src/services/external/DelhiveryClient');
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

const createdPackage = (overrides = {}) => ({
  success: true,
  packages: [{ waybill: 'AWB123', status: 'Success', ...overrides }],
});

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
  it('normalizes a serviceable Delhivery response into a stable shape', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: true,
    });

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: true,
      reason: null,
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: true,
    });
  });

  it('forwards prepaidAvailable independently of codAvailable, for a pincode Delhivery serves COD-only', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: true,
      prepaidAvailable: false,
    });

    const result = await shippingService.checkServiceability({
      destinationPincode: '400001',
    });

    expect(result).toEqual({
      serviceable: true,
      reason: null,
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: true,
      prepaidAvailable: false,
    });
  });

  it('reports INVALID_PINCODE (not a generic error) when Delhivery does not recognize the pincode', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: false,
      recognized: false,
      codAvailable: false,
    });

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

  it('throws a 503 (not a generic 500) when Delhivery times out rather than giving a real answer', async () => {
    const timeoutError = new Error(
      'Delhivery API request timed out after 8000ms'
    );
    timeoutError.isTimeout = true;
    delhiveryClient.checkServiceability.mockRejectedValue(timeoutError);

    await expect(
      shippingService.checkServiceability({ destinationPincode: '400001' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('throws a 503 when Delhivery errors for any other reason', async () => {
    const serverError = new Error('Internal Server Error');
    serverError.statusCode = 500;
    delhiveryClient.checkServiceability.mockRejectedValue(serverError);

    await expect(
      shippingService.checkServiceability({ destinationPincode: '400001' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('checkDeliveryEligibility', () => {
  it('passes through a definitive serviceable result', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: true,
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
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: false,
      recognized: false,
      codAvailable: false,
    });

    const result = await shippingService.checkDeliveryEligibility({
      destinationPincode: '400001',
    });

    expect(result.serviceable).toBe(false);
    expect(result.reason).toBe('INVALID_PINCODE');
  });

  it('fails open (does not block) when the check itself could not get an answer, under the default policy', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.isTimeout = true;
    delhiveryClient.checkServiceability.mockRejectedValue(timeoutError);
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
      prepaidAvailable: true,
      skippedCheck: true,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_closed — a separate describe
// block that loads its own fresh copy of shipping.service.js (and its
// DelhiveryClient mock) under the overridden env var, rather than sharing
// the module instance the rest of this file uses, since the policy is read
// once at require time (see src/config/env.js / shipping.service.js's own
// top-of-file require). Same isolated-reload pattern as
// env.deliveryPricing.test.js.
describe('checkDeliveryEligibility — SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_closed', () => {
  const ORIGINAL_ENV = { ...process.env };
  let delhiveryClientFailClosed;
  let shippingServiceFailClosed;
  let loggerFailClosed;

  beforeEach(() => {
    jest.resetModules();
    process.env.SHIPPING_SERVICEABILITY_FALLBACK_POLICY = 'fail_closed';

    jest.doMock('../../src/services/external/DelhiveryClient', () => ({
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
    delhiveryClientFailClosed = require('../../src/services/external/DelhiveryClient');
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
    delhiveryClientFailClosed.checkServiceability.mockRejectedValue(
      timeoutError
    );
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
      prepaidAvailable: false,
      skippedCheck: true,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still passes through a definitive answer unchanged (policy only governs the failure path)', async () => {
    delhiveryClientFailClosed.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: true,
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
    'rejects %s (%s) as INVALID_FORMAT without calling Delhivery',
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
      expect(delhiveryClient.checkServiceability).not.toHaveBeenCalled();
    }
  );

  it('proceeds to call Delhivery for a well-formed pincode', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: false,
    });

    await shippingService.checkServiceability({ destinationPincode: '400001' });

    expect(delhiveryClient.checkServiceability).toHaveBeenCalledWith({
      destinationPincode: '400001',
    });
  });
});

describe('checkServiceability — normalized pricing contract (subtotal)', () => {
  it('omits deliveryCharge/freeDeliveryThreshold/freeDeliveryEligible when no subtotal is given', async () => {
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: false,
    });

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
    delhiveryClient.checkServiceability.mockResolvedValue({
      serviceable: true,
      recognized: true,
      codAvailable: true,
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
    expect(delhiveryClient.createShipment).not.toHaveBeenCalled();
  });

  it("throws a 400 if the order isn't confirmed yet", async () => {
    mockOrder.findUnique.mockResolvedValue({ ...baseOrder, status: 'draft' });

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(delhiveryClient.createShipment).not.toHaveBeenCalled();
  });

  it('is idempotent — returns the existing shipment without calling Delhivery again', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      id: 'shipment_1',
      orderId: 'order_1',
    });

    const result = await shippingService.createShipmentForOrder('order_1');

    expect(result.alreadyProcessed).toBe(true);
    expect(delhiveryClient.createShipment).not.toHaveBeenCalled();
    expect(mockShipment.create).not.toHaveBeenCalled();
  });

  // Pattern 11 (order/shipment lifecycle audit): the existingShipment
  // pre-check (above) only closes the ordinary case — under a genuine
  // race (two requests both passing that check before either writes),
  // Shipment.orderId's @unique constraint rejects the loser's insert with
  // P2002. This must resolve the same graceful way the ordinary
  // already-processed case does, not surface as a raw crash.
  it('resolves a raced duplicate-insert (P2002 on Shipment.orderId) the same graceful way as the ordinary already-processed case', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique
      .mockResolvedValueOnce(null) // pre-check: no shipment yet, race is on
      .mockResolvedValueOnce({ id: 'shipment_1', orderId: 'order_1' }); // re-fetch after losing the race
    delhiveryClient.createShipment.mockResolvedValue(createdPackage());
    mockShipment.create.mockRejectedValue({ code: 'P2002' });

    const result = await shippingService.createShipmentForOrder('order_1');

    expect(result.alreadyProcessed).toBe(true);
    expect(result.shipment).toEqual({ id: 'shipment_1', orderId: 'order_1' });
  });

  it('creates a shipment with Delhivery, persists it, and marks the order shipped', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    delhiveryClient.createShipment.mockResolvedValue(createdPackage());
    mockShipment.create.mockResolvedValue({
      id: 'shipment_1',
      orderId: 'order_1',
      trackingId: 'AWB123',
    });

    const result = await shippingService.createShipmentForOrder('order_1');

    expect(result.alreadyProcessed).toBe(false);
    expect(delhiveryClient.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: 'order_1',
        payment_mode: 'PREPAID',
        cod_amount: 0,
        consignee: expect.objectContaining({ pincode: '400001' }),
        weight_kg: 0.6, // 0.3kg * quantity 2
      })
    );
    expect(mockShipment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order_1',
          trackingId: 'AWB123',
          awbNumber: 'AWB123',
          // Regression guard: confirmed live that the Prisma schema's
          // @default("Delhivery") alone does NOT take effect without
          // re-running `prisma generate` — must be set explicitly here.
          courierPartner: 'Delhivery',
          status: 'CREATED',
          estimatedDeliveryDate: null,
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
    delhiveryClient.createShipment.mockResolvedValue(createdPackage());
    mockShipment.create.mockResolvedValue({ id: 'shipment_1' });

    await shippingService.createShipmentForOrder('order_1');

    expect(delhiveryClient.createShipment).toHaveBeenCalledWith(
      expect.objectContaining({ payment_mode: 'COD', cod_amount: 999 })
    );
  });

  it('surfaces a clean 422 if Delhivery reports the package could not be created', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    delhiveryClient.createShipment.mockResolvedValue({
      success: true,
      packages: [{ status: 'Fail', remarks: ['Pincode not serviceable'] }],
    });

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mockShipment.create).not.toHaveBeenCalled();
  });

  // Pattern 12 (carrier failure-mode audit): success:true + status:'Success'
  // with no waybill was slipping past the validation and persisting a
  // Shipment with no tracking id, permanently marking the order 'shipped'
  // with nothing anyone could ever track.
  it('surfaces a clean 422 (not a silently-broken shipment) when Delhivery reports success with no waybill assigned', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    delhiveryClient.createShipment.mockResolvedValue({
      success: true,
      packages: [{ status: 'Success', remarks: ['no waybill in response'] }],
    });

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(mockShipment.create).not.toHaveBeenCalled();
    expect(mockOrder.update).not.toHaveBeenCalled();
  });

  it('surfaces a clean 422 (not a raw Delhivery error) if the pincode has fallen out of coverage since the order was confirmed', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    const delhiveryError = new Error('Invalid pincode');
    delhiveryError.statusCode = 422;
    delhiveryClient.createShipment.mockRejectedValue(delhiveryError);

    await expect(
      shippingService.createShipmentForOrder('order_1')
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(mockShipment.create).not.toHaveBeenCalled();
  });

  it('surfaces a 503 if Delhivery is unreachable while creating the shipment', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);
    const timeoutError = new Error('timed out');
    timeoutError.isTimeout = true;
    delhiveryClient.createShipment.mockRejectedValue(timeoutError);

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

  const trackingResponse = (status, extra = {}) => ({
    ShipmentData: [{ Shipment: { Status: { Status: status }, ...extra } }],
  });

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
      trackingId: 'AWB123',
      status: 'CREATED',
    });
    delhiveryClient.trackShipment.mockResolvedValue(
      trackingResponse('In Transit')
    );
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

  // Pattern 12 (carrier failure-mode audit): a poll that comes back with no
  // Status at all (an incomplete/glitchy 200) must not regress an
  // already-progressed shipment's status back to the CREATED default —
  // same "keep the previous value when this poll told us nothing new"
  // reasoning already applied to lastLocation/estimatedDeliveryDate.
  it('keeps the previously stored status when a tracking poll comes back with no Status at all', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'IN_TRANSIT',
      lastLocation: 'Mumbai Hub',
    });
    delhiveryClient.trackShipment.mockResolvedValue({ ShipmentData: [] }); // incomplete/malformed response
    mockShipment.update.mockImplementation(({ data }) => Promise.resolve({ orderId: 'order_1', ...data }));

    const result = await shippingService.trackOrderShipment(
      'order_1',
      requestingOwner
    );

    expect(result.status).toBe('IN_TRANSIT');
    expect(mockShipment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_TRANSIT' }) })
    );
  });

  it('throws a 404 if no shipment exists yet for the order', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue(null);

    await expect(
      shippingService.trackOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the shipment as-is if Delhivery has not yet returned a waybill', async () => {
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
    expect(delhiveryClient.trackShipment).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'DELIVERED', 'RTO_DELIVERED'])(
    'never polls Delhivery (or overwrites the record) once the shipment is already %s',
    async (terminalStatus) => {
      // Regression guard: confirmed live that Delhivery's own tracking API
      // reports a cancelled-before-pickup shipment as "Not Picked" (which
      // maps to CREATED), which would otherwise silently revive a terminal
      // record on the very next poll.
      mockOrder.findUnique.mockResolvedValue(baseOrder);
      mockShipment.findUnique.mockResolvedValue({
        orderId: 'order_1',
        trackingId: 'AWB123',
        status: terminalStatus,
      });

      const result = await shippingService.trackOrderShipment(
        'order_1',
        requestingOwner
      );

      expect(result).toEqual({
        orderId: 'order_1',
        trackingId: 'AWB123',
        status: terminalStatus,
      });
      expect(delhiveryClient.trackShipment).not.toHaveBeenCalled();
      expect(mockShipment.update).not.toHaveBeenCalled();
    }
  );

  it('polls Delhivery, updates the shipment, and syncs the order to delivered', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'OUT_FOR_DELIVERY',
    });
    delhiveryClient.trackShipment.mockResolvedValue(
      trackingResponse('Delivered', {
        Status: { Status: 'Delivered', StatusLocation: 'Mumbai Hub' },
      })
    );
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

  it('does not touch the order for a non-terminal status like In Transit', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
    });
    delhiveryClient.trackShipment.mockResolvedValue(
      trackingResponse('In Transit')
    );
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
      trackingId: 'AWB123',
      status: 'IN_TRANSIT',
      estimatedDeliveryDate: existingEstimate,
    });
    delhiveryClient.trackShipment.mockResolvedValue(
      trackingResponse('In Transit')
    );
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
      trackingId: 'AWB123',
      status: 'IN_TRANSIT',
      estimatedDeliveryDate: new Date('2026-08-20T00:00:00.000Z'),
    });
    delhiveryClient.trackShipment.mockResolvedValue(
      trackingResponse('In Transit', {
        ExpectedDeliveryDate: '2026-08-25T00:00:00.000Z',
      })
    );
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
    expect(delhiveryClient.cancelShipment).not.toHaveBeenCalled();
  });

  it('cancels with Delhivery and updates both the shipment and the order', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'CREATED',
    });
    delhiveryClient.cancelShipment.mockResolvedValue({
      status: true,
      waybill: 'AWB123',
      remark: 'Shipment has been cancelled.',
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

    expect(delhiveryClient.cancelShipment).toHaveBeenCalledWith('AWB123');
    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { orderId: 'order_1' },
      data: { status: 'CANCELLED' },
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'cancelled' },
    });
    expect(result.status).toBe('CANCELLED');
    // Pattern 11 (order/shipment lifecycle audit): every order reaching
    // this function was already 'confirmed' (stock decremented) by the
    // time it had a shipment — cancelling that shipment must give the
    // stock back, same as order.service.js's cancelOrderByCustomer does
    // for a pre-shipment cancellation.
    expect(mockInventoryService.restoreStockForOrder).toHaveBeenCalledWith(
      baseOrder.orderItems
    );
  });

  it('does not restore stock when Delhivery declines the cancellation (shipment stays active, not actually cancelled)', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'CREATED',
    });
    delhiveryClient.cancelShipment.mockResolvedValue({
      status: false,
      remark: 'Already out for delivery.',
    });

    await expect(
      shippingService.cancelOrderShipment('order_1', requestingOwner, 'Changed my mind')
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(mockInventoryService.restoreStockForOrder).not.toHaveBeenCalled();
  });

  it('throws a 422 (and never marks CANCELLED) when Delhivery declines the cancellation', async () => {
    // Confirmed live: cancelling an already-cancelled shipment (or one
    // Delhivery otherwise won't release) returns status:false, not an
    // error — must not be silently treated as success.
    mockOrder.findUnique.mockResolvedValue(baseOrder);
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'CREATED',
    });
    delhiveryClient.cancelShipment.mockResolvedValue({
      status: false,
      waybill: 'AWB123',
    });

    await expect(
      shippingService.cancelOrderShipment('order_1', requestingOwner)
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(mockShipment.update).not.toHaveBeenCalled();
  });

  it('skips the Delhivery call if no tracking id was ever assigned', async () => {
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

    expect(delhiveryClient.cancelShipment).not.toHaveBeenCalled();
  });
});

describe('handleDelhiveryWebhookEvent', () => {
  it('ignores events with no AWB (nothing to reconcile)', async () => {
    await shippingService.handleDelhiveryWebhookEvent({
      Status: { Status: 'Delivered' },
    });

    expect(mockShipment.findUnique).not.toHaveBeenCalled();
  });

  it('warns and no-ops on an AWB it does not recognize', async () => {
    mockShipment.findUnique.mockResolvedValue(null);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await shippingService.handleDelhiveryWebhookEvent({
      AWB: 'UNKNOWN',
      Status: { Status: 'Delivered' },
    });

    expect(mockShipment.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('ignores a webhook event for a shipment that is already terminal (CANCELLED)', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'CANCELLED',
    });

    await shippingService.handleDelhiveryWebhookEvent({
      AWB: 'AWB123',
      Status: { Status: 'Not Picked' },
    });

    expect(mockShipment.update).not.toHaveBeenCalled();
    expect(mockOrder.update).not.toHaveBeenCalled();
  });

  // Pattern 12: mirror of trackOrderShipment's own regression test — a
  // webhook payload with no Status at all must not stomp an
  // already-progressed shipment's status back to the CREATED default.
  it('keeps the previously stored status when the webhook payload carries no Status at all', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'IN_TRANSIT',
    });
    mockShipment.update.mockImplementation(({ data }) =>
      Promise.resolve({ orderId: 'order_1', ...data })
    );

    await shippingService.handleDelhiveryWebhookEvent({ AWB: 'AWB123' });

    expect(mockShipment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'IN_TRANSIT' }) })
    );
  });

  it('updates the shipment and syncs the order on a recognized delivery event', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'OUT_FOR_DELIVERY',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'DELIVERED',
    });

    await shippingService.handleDelhiveryWebhookEvent({
      AWB: 'AWB123',
      Status: { Status: 'Delivered', StatusLocation: 'Mumbai Hub' },
    });

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { trackingId: 'AWB123' },
      data: expect.objectContaining({ status: 'DELIVERED' }),
    });
    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'delivered' },
    });
  });

  it('maps an RTO Delivered event to a returned order', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'RTO_DELIVERED',
    });

    await shippingService.handleDelhiveryWebhookEvent({
      AWB: 'AWB123',
      Status: { Status: 'RTO Delivered' },
    });

    expect(mockOrder.update).toHaveBeenCalledWith({
      where: { id: 'order_1' },
      data: { status: 'returned' },
    });
  });

  it('also accepts a payload nested under Shipment (assumed webhook shape)', async () => {
    mockShipment.findUnique.mockResolvedValue({
      orderId: 'order_1',
      trackingId: 'AWB123',
      status: 'OUT_FOR_DELIVERY',
    });
    mockShipment.update.mockResolvedValue({
      orderId: 'order_1',
      status: 'DELIVERED',
    });

    await shippingService.handleDelhiveryWebhookEvent({
      Shipment: { AWB: 'AWB123', Status: { Status: 'Delivered' } },
    });

    expect(mockShipment.update).toHaveBeenCalledWith({
      where: { trackingId: 'AWB123' },
      data: expect.objectContaining({ status: 'DELIVERED' }),
    });
  });
});
