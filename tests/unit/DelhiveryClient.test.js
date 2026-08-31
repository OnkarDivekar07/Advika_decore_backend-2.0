// tests/unit/DelhiveryClient.test.js
//
// Regression coverage for the request shapes confirmed by actually
// creating, tracking, and cancelling a real test shipment against a real
// Delhivery account (see DelhiveryClient.js's file header). Two real bugs
// were caught this way and are guarded here specifically:
//   1. Every request needs an `Accept: application/json` header — without
//      it, /api/p/edit (cancel/update) replies with XML instead of JSON.
//   2. /api/p/edit takes PLAIN form fields directly — unlike
//      /api/cmu/create.json, it does NOT use the `data=<JSON>` wrapper.
const mockFetch = jest.fn();
global.fetch = mockFetch;

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

beforeEach(() => {
  jest.resetModules();
  mockFetch.mockReset();
  process.env.DELHIVERY_BASE_URL = 'https://track.delhivery.com';
  process.env.DELHIVERY_API_TOKEN = 'test-token';
  process.env.DELHIVERY_WEBHOOK_SECRET = 'test-webhook-secret';
});

const loadClient = () => require('../../src/services/external/DelhiveryClient');

describe('every request', () => {
  it('sends Authorization: Token <token> and Accept: application/json', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ delivery_codes: [] }));
    const client = loadClient();

    await client.checkServiceability({ destinationPincode: '400001' });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Token test-token');
    expect(options.headers.Accept).toBe('application/json');
  });
});

describe('checkServiceability', () => {
  it('GETs the pin-codes lookup with the destination pincode', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ delivery_codes: [] }));
    const client = loadClient();

    await client.checkServiceability({ destinationPincode: '400001' });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/c/api/pin-codes/json/');
    expect(url).toContain('filter_codes=400001');
    expect(options.method).toBe('GET');
  });

  it('normalizes a recognized entry as serviceable', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        delivery_codes: [{ postal_code: { pin: '400001', cod: 'Y', pre_paid: 'Y' } }],
      })
    );
    const client = loadClient();

    const result = await client.checkServiceability({ destinationPincode: '400001' });

    expect(result).toEqual({
      serviceable: true,
      recognized: true,
      codAvailable: true,
      prepaidAvailable: true,
    });
  });

  it('normalizes an empty delivery_codes array as unrecognized', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ delivery_codes: [] }));
    const client = loadClient();

    const result = await client.checkServiceability({ destinationPincode: '999999' });

    expect(result).toEqual({
      serviceable: false,
      recognized: false,
      codAvailable: false,
    });
  });
});

describe('createShipment', () => {
  it('POSTs form-encoded format=json&data=<JSON> to /api/cmu/create.json', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ success: true, packages: [{ waybill: 'AWB1', status: 'Success' }] })
    );
    const client = loadClient();

    await client.createShipment({
      order_id: 'order_1',
      payment_mode: 'COD',
      cod_amount: 500,
      pickup_location_name: 'Main Warehouse',
      seller_name: 'Advika Auto',
      consignee: {
        name: 'Jane Doe',
        phone: '9999999999',
        address: '221B Baker Street',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      },
      products_desc: 'Mug',
      quantity: 2,
      total_amount: 500,
      weight_kg: 0.6,
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/cmu/create.json');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const parsedBody = new URLSearchParams(options.body);
    expect(parsedBody.get('format')).toBe('json');
    const data = JSON.parse(parsedBody.get('data'));
    expect(data.pickup_location).toEqual({ name: 'Main Warehouse' });
    expect(data.shipments[0]).toMatchObject({
      name: 'Jane Doe',
      pin: '400001',
      order: 'order_1',
      payment_mode: 'COD',
      cod_amount: 500,
      // Grams, not kilograms.
      weight: 600,
    });
  });
});

describe('trackShipment', () => {
  it('GETs the packages endpoint with the waybill', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ShipmentData: [] }));
    const client = loadClient();

    await client.trackShipment('AWB123');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/packages/json/');
    expect(url).toContain('waybill=AWB123');
    expect(options.method).toBe('GET');
  });
});

describe('cancelShipment', () => {
  it('POSTs PLAIN form fields (no data= wrapper) to /api/p/edit', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ status: true, waybill: 'AWB123', remark: 'Shipment has been cancelled.' })
    );
    const client = loadClient();

    const result = await client.cancelShipment('AWB123');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/p/edit');
    expect(options.method).toBe('POST');
    const parsedBody = new URLSearchParams(options.body);
    expect(parsedBody.get('waybill')).toBe('AWB123');
    expect(parsedBody.get('cancellation')).toBe('true');
    // Regression guard: this endpoint does NOT use create-shipment's
    // data=<JSON> wrapper.
    expect(parsedBody.get('data')).toBeNull();
    expect(result).toEqual({
      status: true,
      waybill: 'AWB123',
      remark: 'Shipment has been cancelled.',
    });
  });

  it('resolves with status:false (not a thrown error) when Delhivery declines', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: false, waybill: 'AWB123' }));
    const client = loadClient();

    const result = await client.cancelShipment('AWB123');

    expect(result.status).toBe(false);
  });
});

describe('updateShipment', () => {
  it('POSTs plain form fields merging the waybill with the given updates', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ status: true }));
    const client = loadClient();

    await client.updateShipment('AWB123', { phone: '8888888888' });

    const [, options] = mockFetch.mock.calls[0];
    const parsedBody = new URLSearchParams(options.body);
    expect(parsedBody.get('waybill')).toBe('AWB123');
    expect(parsedBody.get('phone')).toBe('8888888888');
    expect(parsedBody.get('data')).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  it('rejects when DELHIVERY_WEBHOOK_SECRET is not set', () => {
    delete process.env.DELHIVERY_WEBHOOK_SECRET;
    const client = loadClient();

    expect(client.verifyWebhookSignature('raw-body', 'any-signature')).toBe(false);
  });

  it('accepts a correctly-signed payload and rejects a tampered one', () => {
    const client = loadClient();
    const crypto = require('crypto');
    const rawBody = 'raw-body-content';
    const goodSignature = crypto
      .createHmac('sha256', 'test-webhook-secret')
      .update(rawBody)
      .digest('hex');

    expect(client.verifyWebhookSignature(rawBody, goodSignature)).toBe(true);
    expect(client.verifyWebhookSignature(rawBody, 'wrong-signature')).toBe(false);
  });
});
