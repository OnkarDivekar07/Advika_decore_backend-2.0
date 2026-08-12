// tests/unit/env.deliveryPricing.test.js
//
// FREE_DELIVERY_THRESHOLD / DELIVERY_CHARGE (src/config/env.js) are the one
// thing in env.js meant to be overridden per-deployment rather than always
// coming from tests/setup/env.js's fixed values, so this exercises the
// parsing directly via jest.resetModules() + a fresh require, rather than
// relying on whatever the global test env happens to have set.

const ORIGINAL_ENV = { ...process.env };

const loadEnvWith = (overrides) => {
  jest.resetModules();
  Object.assign(process.env, overrides);
  // eslint-disable-next-line global-require
  return require('@config/env');
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

describe('delivery pricing env config', () => {
  it('defaults to 600 / 49 when unset', () => {
    delete process.env.FREE_DELIVERY_THRESHOLD;
    delete process.env.DELIVERY_CHARGE;

    const env = loadEnvWith({});

    expect(env.freeDeliveryThreshold).toBe(600);
    expect(env.deliveryCharge).toBe(49);
  });

  it('honors valid overrides from the environment', () => {
    const env = loadEnvWith({ FREE_DELIVERY_THRESHOLD: '999', DELIVERY_CHARGE: '25' });

    expect(env.freeDeliveryThreshold).toBe(999);
    expect(env.deliveryCharge).toBe(25);
  });

  it('allows a zero delivery charge (always-free delivery)', () => {
    const env = loadEnvWith({ DELIVERY_CHARGE: '0' });

    expect(env.deliveryCharge).toBe(0);
  });

  it('throws at load time on a negative value', () => {
    expect(() => loadEnvWith({ DELIVERY_CHARGE: '-5' })).toThrow(/DELIVERY_CHARGE/);
  });

  it('throws at load time on a non-numeric value', () => {
    expect(() => loadEnvWith({ FREE_DELIVERY_THRESHOLD: 'not-a-number' })).toThrow(
      /FREE_DELIVERY_THRESHOLD/
    );
  });
});

describe('shipping serviceability fallback policy env config', () => {
  it('defaults to fail_open when unset', () => {
    delete process.env.SHIPPING_SERVICEABILITY_FALLBACK_POLICY;

    const env = loadEnvWith({});

    expect(env.shippingServiceabilityFallbackPolicy).toBe('fail_open');
  });

  it('honors an explicit fail_open override', () => {
    const env = loadEnvWith({ SHIPPING_SERVICEABILITY_FALLBACK_POLICY: 'fail_open' });

    expect(env.shippingServiceabilityFallbackPolicy).toBe('fail_open');
  });

  it('honors an explicit fail_closed override', () => {
    const env = loadEnvWith({ SHIPPING_SERVICEABILITY_FALLBACK_POLICY: 'fail_closed' });

    expect(env.shippingServiceabilityFallbackPolicy).toBe('fail_closed');
  });

  it('throws at load time on an unrecognized policy value', () => {
    expect(() =>
      loadEnvWith({ SHIPPING_SERVICEABILITY_FALLBACK_POLICY: 'sometimes' })
    ).toThrow(/SHIPPING_SERVICEABILITY_FALLBACK_POLICY/);
  });
});
