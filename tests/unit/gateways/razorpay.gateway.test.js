const crypto = require('crypto');

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn(), fetch: jest.fn(), fetchPayments: jest.fn() },
    payments: { fetch: jest.fn() },
  }))
);

const Razorpay = require('razorpay');
const razorpayGateway = require('@modules/payment/gateways/razorpay.gateway');

const razorpayInstance = Razorpay.mock.results[0].value;

describe('razorpay.gateway', () => {
  it('exposes the contract-required name and publicConfig', () => {
    expect(razorpayGateway.name).toBe('razorpay');
    expect(razorpayGateway.publicConfig).toEqual({
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  });

  describe('createOrder', () => {
    it('normalizes the SDK order response and keeps the raw payload', async () => {
      razorpayInstance.orders.create.mockResolvedValue({
        id: 'rzp_order_1',
        amount: 50000,
        currency: 'INR',
        status: 'created',
        receipt: 'order_1',
      });

      const result = await razorpayGateway.createOrder({
        amount: 50000,
        currency: 'INR',
        receipt: 'order_1',
      });

      expect(result).toEqual({
        id: 'rzp_order_1',
        amount: 50000,
        currency: 'INR',
        status: 'created',
        raw: expect.objectContaining({ id: 'rzp_order_1', receipt: 'order_1' }),
      });
    });

    it('propagates a failure rather than swallowing it (the caller wraps this)', async () => {
      razorpayInstance.orders.create.mockRejectedValue(
        new Error('network down')
      );

      await expect(
        razorpayGateway.createOrder({
          amount: 50000,
          currency: 'INR',
          receipt: 'order_1',
        })
      ).rejects.toThrow('network down');
    });
  });

  describe('fetchOrder', () => {
    it('normalizes a found order', async () => {
      razorpayInstance.orders.fetch.mockResolvedValue({
        id: 'rzp_order_1',
        amount: 50000,
        currency: 'INR',
        status: 'paid',
      });

      const result = await razorpayGateway.fetchOrder('rzp_order_1');

      expect(result).toEqual({
        id: 'rzp_order_1',
        amount: 50000,
        currency: 'INR',
        status: 'paid',
        raw: expect.objectContaining({ id: 'rzp_order_1' }),
      });
    });

    it('resolves null instead of throwing on failure', async () => {
      razorpayInstance.orders.fetch.mockRejectedValue(new Error('not found'));

      await expect(razorpayGateway.fetchOrder('missing')).resolves.toBeNull();
    });
  });

  describe('fetchOrderPayments', () => {
    it('normalizes each payment in the list', async () => {
      razorpayInstance.orders.fetchPayments.mockResolvedValue({
        items: [
          {
            id: 'pay_1',
            order_id: 'rzp_order_1',
            status: 'captured',
            amount: 50000,
          },
        ],
      });

      const result = await razorpayGateway.fetchOrderPayments('rzp_order_1');

      expect(result).toEqual([
        {
          id: 'pay_1',
          order_id: 'rzp_order_1',
          status: 'captured',
          amount: 50000,
          raw: expect.objectContaining({ id: 'pay_1' }),
        },
      ]);
    });

    it('resolves [] instead of throwing on failure', async () => {
      razorpayInstance.orders.fetchPayments.mockRejectedValue(
        new Error('network down')
      );

      await expect(
        razorpayGateway.fetchOrderPayments('rzp_order_1')
      ).resolves.toEqual([]);
    });
  });

  describe('fetchPayment', () => {
    it('normalizes a found payment', async () => {
      razorpayInstance.payments.fetch.mockResolvedValue({
        id: 'pay_1',
        order_id: 'rzp_order_1',
        status: 'captured',
        amount: 50000,
      });

      const result = await razorpayGateway.fetchPayment('pay_1');

      expect(result).toEqual({
        id: 'pay_1',
        order_id: 'rzp_order_1',
        status: 'captured',
        amount: 50000,
        raw: expect.objectContaining({ id: 'pay_1' }),
      });
    });

    it('resolves null instead of throwing on failure', async () => {
      razorpayInstance.payments.fetch.mockRejectedValue(new Error('not found'));

      await expect(razorpayGateway.fetchPayment('missing')).resolves.toBeNull();
    });
  });

  describe('verifyPaymentSignature', () => {
    const orderId = 'order_ABC123';
    const paymentId = 'pay_XYZ789';

    const sign = (o, p, secret = process.env.RAZORPAY_KEY_SECRET) =>
      crypto
        .createHmac('sha256', secret)
        .update(o + '|' + p)
        .digest('hex');

    it('returns true for a signature generated with the correct secret', () => {
      expect(
        razorpayGateway.verifyPaymentSignature({
          orderId,
          paymentId,
          signature: sign(orderId, paymentId),
        })
      ).toBe(true);
    });

    it('returns false when the signature was generated with the wrong secret', () => {
      expect(
        razorpayGateway.verifyPaymentSignature({
          orderId,
          paymentId,
          signature: sign(orderId, paymentId, 'wrong-secret'),
        })
      ).toBe(false);
    });

    it('returns false when no signature is provided', () => {
      expect(
        razorpayGateway.verifyPaymentSignature({
          orderId,
          paymentId,
          signature: undefined,
        })
      ).toBe(false);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('returns true for a signature generated over the exact raw body', () => {
      const rawBody = Buffer.from(
        JSON.stringify({ event: 'payment.captured' })
      );
      const signature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

      expect(razorpayGateway.verifyWebhookSignature(rawBody, signature)).toBe(
        true
      );
    });

    it('returns false if the body was modified after signing', () => {
      const original = Buffer.from(
        JSON.stringify({ event: 'payment.captured' })
      );
      const signature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(original)
        .digest('hex');
      const tampered = Buffer.from(JSON.stringify({ event: 'payment.failed' }));

      expect(razorpayGateway.verifyWebhookSignature(tampered, signature)).toBe(
        false
      );
    });
  });

  describe('parseWebhookEvent', () => {
    it('extracts the event type and normalized payment entity', () => {
      const result = razorpayGateway.parseWebhookEvent({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'rzp_order_1',
              status: 'captured',
              amount: 50000,
            },
          },
        },
      });

      expect(result).toEqual({
        eventType: 'payment.captured',
        payment: {
          id: 'pay_1',
          order_id: 'rzp_order_1',
          status: 'captured',
          amount: 50000,
          raw: expect.objectContaining({ id: 'pay_1' }),
        },
      });
    });

    it('returns a null payment for events with no payment entity', () => {
      const result = razorpayGateway.parseWebhookEvent({
        event: 'order.paid',
        payload: {},
      });

      expect(result).toEqual({ eventType: 'order.paid', payment: null });
    });
  });
});
