// The selector describe block below re-requires @modules/payment/gateways
// fresh (via jest.resetModules()), which pulls in the real
// razorpay.gateway.js — mock the SDK it constructs so that never risks a
// real network client, same as every other test touching this module.
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn(), fetch: jest.fn(), fetchPayments: jest.fn() },
    payments: { fetch: jest.fn() },
  }))
);

const { assertImplementsContract, REQUIRED_METHODS } = require('@modules/payment/gateways/paymentGateway.contract');

const completeGateway = () => {
  const gateway = { name: 'fake' };
  REQUIRED_METHODS.forEach((method) => {
    gateway[method] = () => {};
  });
  return gateway;
};

describe('paymentGateway.contract', () => {
  it('does not throw for an adapter implementing every required method', () => {
    expect(() => assertImplementsContract(completeGateway())).not.toThrow();
  });

  it('throws listing whichever required method(s) are missing', () => {
    const gateway = completeGateway();
    delete gateway.verifyWebhookSignature;
    delete gateway.parseWebhookEvent;

    expect(() => assertImplementsContract(gateway)).toThrow(
      /verifyWebhookSignature, parseWebhookEvent/
    );
  });

  it('throws when the adapter has no name', () => {
    const gateway = completeGateway();
    gateway.name = '';

    expect(() => assertImplementsContract(gateway)).toThrow(/non-empty string `name`/);
  });
});

describe('gateways/index (selector)', () => {
  const ORIGINAL_ENV = process.env.PAYMENT_GATEWAY;

  afterEach(() => {
    process.env.PAYMENT_GATEWAY = ORIGINAL_ENV;
    jest.resetModules();
  });

  it('defaults to the razorpay adapter when PAYMENT_GATEWAY is unset', () => {
    delete process.env.PAYMENT_GATEWAY;
    jest.resetModules();

    // eslint-disable-next-line global-require
    const gateway = require('@modules/payment/gateways');
    expect(gateway.name).toBe('razorpay');
  });

  it('throws for an unknown PAYMENT_GATEWAY value rather than silently falling back', () => {
    process.env.PAYMENT_GATEWAY = 'some_unregistered_provider';
    jest.resetModules();

    // eslint-disable-next-line global-require
    expect(() => require('@modules/payment/gateways')).toThrow(/Unknown PAYMENT_GATEWAY/);
  });
});
