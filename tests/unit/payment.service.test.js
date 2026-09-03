const crypto = require('crypto');

// --- Mocks -------------------------------------------------------------
// Razorpay SDK: never hit the network. Capture the constructed instance so
// individual tests can control what orders.create() resolves/rejects with.
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    payments: { refund: jest.fn(), fetchRefund: jest.fn(), fetchMultipleRefund: jest.fn() },
  }))
);

// Prisma: the same mock objects back both the top-level client
// (`prisma.order.*`) and the transaction client handed to `$transaction`'s
// callback (`tx.order.*`), since payment.service.js uses both depending on
// the code path.
const mockOrder = {
  update: jest.fn(),
  updateMany: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
};
// Backs the WebhookEvent ledger's `create` call — handleRazorpayWebhookEvent
// uses this to detect an exact-duplicate event delivery (see its own tests
// below). Defaults to resolving (a fresh event id) so every other existing
// test in this file — none of which pass an eventId — is unaffected.
const mockWebhookEvent = {
  create: jest.fn().mockResolvedValue({}),
};
// Backs the RefundAttempt ledger refundOrderPayment/reconcileUnresolvedRefunds
// use — see prisma/schema.prisma's RefundAttempt model. `findUnique`
// defaults to resolving null (no matching attempt) so the webhook's refund
// branch falls back to its pre-existing payment_id-only match path unless
// a test explicitly sets one up.
const mockRefundAttempt = {
  create: jest.fn().mockResolvedValue({ id: 'attempt_1' }),
  update: jest.fn().mockResolvedValue({}),
  findUnique: jest.fn().mockResolvedValue(null),
  findMany: jest.fn(),
};

// handleRazorpayWebhookEvent now writes the ledger row and applies the
// order mutation inside one `prisma.$transaction` (both via `tx`, not the
// top-level `prisma` client — see payment.service.js's own comment on why),
// so `mockTx` needs a `webhookEvent` alongside `order`, sharing the same
// mock instances as the top-level client so assertions against
// `mockOrder`/`mockWebhookEvent` pass regardless of which one a given call
// path happens to go through.
const mockTx = { order: mockOrder, webhookEvent: mockWebhookEvent, refundAttempt: mockRefundAttempt };

jest.mock('@config/prisma', () => ({
  order: mockOrder,
  webhookEvent: mockWebhookEvent,
  refundAttempt: mockRefundAttempt,
  $transaction: jest.fn(async (cb) => cb(mockTx)),
}));

jest.mock('@modules/inventory/inventory.service', () => ({
  decrementStockForOrder: jest.fn(),
  restoreStockForOrder: jest.fn(),
}));

jest.mock('@modules/order/order.service', () => ({
  detectOrderConflicts: jest.fn(),
  detectAddressConflict: jest.fn(),
  detectPricingConflict: jest.fn(),
  CANCELLABLE_ORDER_STATUSES: ['pending', 'confirmed'],
}));

jest.mock('../../src/jobs/queues/clearCartQueue', () => ({
  add: jest.fn(),
}));

// Without this mock, requiring payment.service.js pulls in the real
// notificationQueue (BullMQ + ioredis), which tries to open a live Redis
// connection. In an environment with no Redis running, `.add()` on that
// real queue never resolves, so every code path in payment.service.js
// that queues an 'order-confirmation' job (updateOrderAfterPayment,
// handleRazorpayWebhookEvent's payment.captured branch, handleCODOrder)
// hangs until Jest's 5s test timeout fires — surfacing as a timeout
// failure rather than a real assertion failure.
jest.mock('../../src/jobs/queues/notificationQueue', () => ({
  add: jest.fn(),
}));

const Razorpay = require('razorpay');
const prisma = require('@config/prisma');
const inventoryService = require('@modules/inventory/inventory.service');
const orderService = require('@modules/order/order.service');
const cartQueue = require('../../src/jobs/queues/clearCartQueue');
const notificationQueue = require('../../src/jobs/queues/notificationQueue');
const paymentService = require('@modules/payment/payment.service');

const razorpayInstance = Razorpay.mock.results[0].value;

describe('payment.service', () => {
  describe('verifyRazorpaySignature', () => {
    const orderId = 'order_ABC123';
    const paymentId = 'pay_XYZ789';

    const sign = (
      orderId,
      paymentId,
      secret = process.env.RAZORPAY_KEY_SECRET
    ) =>
      crypto
        .createHmac('sha256', secret)
        .update(orderId + '|' + paymentId)
        .digest('hex');

    it('returns true for a signature generated with the correct secret', () => {
      const signature = sign(orderId, paymentId);
      expect(
        paymentService.verifyRazorpaySignature(orderId, paymentId, signature)
      ).toBe(true);
    });

    it('returns false when the signature was generated with the wrong secret', () => {
      const signature = sign(orderId, paymentId, 'wrong-secret');
      expect(
        paymentService.verifyRazorpaySignature(orderId, paymentId, signature)
      ).toBe(false);
    });

    it('returns false when the signature is tampered with (different length)', () => {
      expect(
        paymentService.verifyRazorpaySignature(orderId, paymentId, 'short')
      ).toBe(false);
    });

    it('returns false when no signature is provided', () => {
      expect(
        paymentService.verifyRazorpaySignature(orderId, paymentId, undefined)
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

      expect(paymentService.verifyWebhookSignature(rawBody, signature)).toBe(
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
      expect(paymentService.verifyWebhookSignature(tampered, signature)).toBe(
        false
      );
    });
  });

  describe('createRazorpayOrder', () => {
    beforeEach(() => {
      razorpayInstance.orders.create.mockReset();
      mockOrder.updateMany.mockReset();
    });

    it('creates a Razorpay order and stashes the id on our order', async () => {
      razorpayInstance.orders.create.mockResolvedValue({
        id: 'rzp_order_1',
        amount: 50000,
      });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      const result = await paymentService.createRazorpayOrder({
        amount: 50000,
        receipt: 'order_1',
        order_id: 'order_1',
        previousPaymentOrderId: null,
      });

      // razorpayOrder now comes back through the gateway adapter's
      // normalized shape (see gateways/razorpay.gateway.js) — id/amount
      // pass through unchanged, plus currency/status/raw from the
      // (here-undefined) fields the mocked SDK response didn't set.
      expect(result).toEqual({
        razorpayOrder: expect.objectContaining({
          id: 'rzp_order_1',
          amount: 50000,
        }),
        persisted: true,
      });
      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'order_1', payment_order_id: null },
        data: { payment_order_id: 'rzp_order_1', paymentStatus: 'attempted' },
      });
    });

    // Two concurrent create-orderid calls for the same draft order (see
    // payment.controller.js) — this call created a Razorpay order but lost
    // the compare-and-swap because some other call already linked a
    // different payment_order_id to this draft order first.
    it('reports persisted: false when another concurrent call already linked a different payment_order_id', async () => {
      razorpayInstance.orders.create.mockResolvedValue({
        id: 'rzp_order_loser',
        amount: 50000,
      });
      mockOrder.updateMany.mockResolvedValue({ count: 0 });

      const result = await paymentService.createRazorpayOrder({
        amount: 50000,
        receipt: 'order_1',
        order_id: 'order_1',
        previousPaymentOrderId: null,
      });

      expect(result.persisted).toBe(false);
      expect(result.razorpayOrder).toEqual(
        expect.objectContaining({ id: 'rzp_order_loser', amount: 50000 })
      );
    });

    it('wraps a Razorpay failure in a 500 CustomError', async () => {
      razorpayInstance.orders.create.mockRejectedValue(
        new Error('network down')
      );

      await expect(
        paymentService.createRazorpayOrder({
          amount: 50000,
          receipt: 'order_1',
          order_id: 'order_1',
        })
      ).rejects.toMatchObject({
        message: 'Unable to create payment order.',
        statusCode: 500,
      });
    });
  });

  describe('updateOrderAfterPayment', () => {
    beforeEach(() => {
      mockOrder.updateMany.mockReset();
      mockOrder.findUnique.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      cartQueue.add.mockReset();
    });

    it('decrements stock and clears the cart the first time an order is marked paid', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [{ productId: 'p1', quantity: 2 }],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);

      const result = await paymentService.updateOrderAfterPayment(
        'rzp_order_1',
        'pay_1'
      );

      expect(result.alreadyProcessed).toBe(false);
      // Wrapped in its own prisma.$transaction now (see runFulfillment's
      // own comment on why) — the mock's $transaction hands the callback
      // mockTx, not the top-level prisma client, same as every other
      // transactional call in this file.
      expect(inventoryService.decrementStockForOrder).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 2 }],
        mockTx,
        { throwOnInsufficientStock: false }
      );
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: { stockDecremented: true },
      });
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          fulfillmentAttempts: { increment: 1 },
          fulfillmentStatus: 'completed',
          fulfillmentError: null,
        },
      });
    });

    it('is a no-op (no double stock decrement, no double cart clear) on a repeat call', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 0 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [{ productId: 'p1', quantity: 2 }],
      });

      const result = await paymentService.updateOrderAfterPayment(
        'rzp_order_1',
        'pay_1'
      );

      expect(result.alreadyProcessed).toBe(true);
      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    it('throws a 404 if no order matches the Razorpay order id', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.updateOrderAfterPayment('rzp_order_missing', 'pay_1')
      ).rejects.toMatchObject({
        message: 'Order not found for this payment',
        statusCode: 404,
      });
    });

    // Previously an oversold order was only ever logged (see the
    // "paid-order fulfillment can fail permanently" review finding) — now
    // it's durably recorded so reconcileFailedFulfillments/
    // getOperationalAlerts can actually do something with it. Never resolves
    // to 'completed', even though cart-clear/notification still succeed —
    // the underlying inventory problem needs a human, not a retry.
    it('marks a paid-but-oversold order failed/oversold instead of only logging it', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [{ productId: 'p1', quantity: 5 }],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([
        { productId: 'p1', quantity: 5 },
      ]);

      await paymentService.updateOrderAfterPayment('rzp_order_1', 'pay_1');

      // Still runs the retryable steps — the order really is confirmed and
      // paid regardless of the inventory problem.
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
      expect(notificationQueue.add).toHaveBeenCalledWith(
        'order-confirmation',
        { orderId: 'order_1' }
      );
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: { stockDecremented: true, oversold: true },
      });
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          fulfillmentAttempts: { increment: 1 },
          fulfillmentStatus: 'failed',
          fulfillmentError:
            'Paid but oversold — insufficient stock for one or more items in this order.',
        },
      });
    });

    // The original design flaw this whole area fixes: a queue outage after
    // a real payment must never surface as a payment failure, and must
    // leave a durable, retryable trace rather than only a log line.
    it('records a fulfillment failure (and never throws) when the cart-clear/notification enqueue fails', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [{ productId: 'p1', quantity: 1 }],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);
      cartQueue.add.mockRejectedValueOnce(new Error('Redis unreachable'));

      const result = await paymentService.updateOrderAfterPayment(
        'rzp_order_1',
        'pay_1'
      );

      // The payment/order write already happened — a fulfillment-side
      // failure must never read back as "the payment didn't go through."
      expect(result.alreadyProcessed).toBe(false);
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          fulfillmentStatus: 'failed',
          fulfillmentError: 'Redis unreachable',
          fulfillmentAttempts: { increment: 1 },
        },
      });
    });
  });

  describe('handleRazorpayWebhookEvent', () => {
    beforeEach(() => {
      mockOrder.updateMany.mockReset();
      mockOrder.findUnique.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      cartQueue.add.mockReset();
      mockWebhookEvent.create.mockReset();
      mockWebhookEvent.create.mockResolvedValue({});
    });

    it('ignores events with no payment order id (nothing to reconcile)', async () => {
      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.captured',
        payload: {},
      });

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
    });

    it('marks the order paid and decrements stock on payment.captured', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [{ productId: 'p1', quantity: 1 }],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          payment_order_id: 'rzp_order_1',
          paymentStatus: { not: 'paid' },
        },
        data: {
          paymentStatus: 'paid',
          status: 'confirmed',
          payment_id: 'pay_1',
        },
      });
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
    });

    it('does not re-apply side effects for a duplicate payment.captured delivery', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 0 });

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockOrder.findUnique).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    it('marks the order failed on payment.failed, but only if not already paid', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.failed',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          payment_order_id: 'rzp_order_1',
          paymentStatus: { not: 'paid' },
        },
        data: { paymentStatus: 'failed', payment_id: 'pay_1' },
      });
    });

    it('marks the order processing on payment.authorized, only moving it forward from a non-terminal state', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.authorized',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          payment_order_id: 'rzp_order_1',
          paymentStatus: { in: ['pending', 'attempted', 'processing'] },
        },
        data: { paymentStatus: 'processing', payment_id: 'pay_1' },
      });
    });

    it('acks unhandled event types without touching the order', async () => {
      await paymentService.handleRazorpayWebhookEvent({
        event: 'order.paid',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
    });

    it('logs a verified event to the WebhookEvent ledger before processing it', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);

      await paymentService.handleRazorpayWebhookEvent(
        {
          event: 'payment.captured',
          payload: {
            payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
          },
        },
        'evt_123'
      );

      expect(mockWebhookEvent.create).toHaveBeenCalledWith({
        data: {
          source: 'razorpay',
          eventId: 'evt_123',
          eventType: 'payment.captured',
          orderId: 'rzp_order_1',
          paymentId: 'pay_1',
          payload: expect.objectContaining({ event: 'payment.captured' }),
        },
      });
      expect(mockOrder.updateMany).toHaveBeenCalled();
    });

    it('skips all processing for an event id already in the ledger (exact-duplicate delivery)', async () => {
      const duplicateError = new Error('Unique constraint failed');
      duplicateError.code = 'P2002';
      mockWebhookEvent.create.mockRejectedValue(duplicateError);

      await paymentService.handleRazorpayWebhookEvent(
        {
          event: 'payment.captured',
          payload: {
            payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
          },
        },
        'evt_already_seen'
      );

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    it('still processes the event if the ledger write fails for a non-duplicate reason', async () => {
      mockWebhookEvent.create.mockRejectedValue(new Error('DB unavailable'));
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);

      await paymentService.handleRazorpayWebhookEvent(
        {
          event: 'payment.captured',
          payload: {
            payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
          },
        },
        'evt_456'
      );

      expect(mockOrder.updateMany).toHaveBeenCalled();
    });

    it('skips the ledger write entirely when no event id is provided (falls back to order-level idempotency only)', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        orderItems: [],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } },
        },
      });

      expect(mockWebhookEvent.create).not.toHaveBeenCalled();
      expect(mockOrder.updateMany).toHaveBeenCalled();
    });

    describe('refund.processed / refund.failed', () => {
      it('ignores a refund event with no payment id (nothing to reconcile)', async () => {
        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.processed',
          payload: {},
        });

        expect(mockOrder.updateMany).not.toHaveBeenCalled();
      });

      // Fixes the "refund failure can create an incorrect business state"
      // review finding: `status` only ever moves to 'cancelled' — and
      // stock is only ever restored — once refund.processed genuinely
      // confirms the refund completed, never at initiation.
      it('moves a refund_pending order to refunded/cancelled and restores its stock on refund.processed', async () => {
        mockOrder.updateMany.mockResolvedValue({ count: 1 });
        mockOrder.findFirst.mockResolvedValue({
          id: 'order_1',
          orderItems: [{ productId: 'p1', quantity: 2 }],
        });

        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.processed',
          payload: {
            refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } },
          },
        });

        expect(mockOrder.updateMany).toHaveBeenCalledWith({
          where: { payment_id: 'pay_1', paymentStatus: 'refund_pending' },
          data: { paymentStatus: 'refunded', status: 'cancelled' },
        });
        expect(inventoryService.restoreStockForOrder).toHaveBeenCalledWith(
          [{ productId: 'p1', quantity: 2 }],
          mockTx
        );
      });

      // The exact scenario the review finding describes: a refund
      // Razorpay ultimately rejects must never leave the order looking
      // cancelled or its stock already given back — both stay exactly as
      // they were, so an admin (via getOperationalAlerts' payment
      // exceptions, which now includes 'refund_failed') can resolve it
      // without a customer having lost both their money and their order.
      it('moves a refund_pending order to refund_failed on refund.failed, without touching status or stock', async () => {
        mockOrder.updateMany.mockResolvedValue({ count: 1 });

        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.failed',
          payload: {
            refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } },
          },
        });

        expect(mockOrder.updateMany).toHaveBeenCalledWith({
          where: { payment_id: 'pay_1', paymentStatus: 'refund_pending' },
          data: { paymentStatus: 'refund_failed' },
        });
        expect(mockOrder.findFirst).not.toHaveBeenCalled();
        expect(inventoryService.restoreStockForOrder).not.toHaveBeenCalled();
      });

      it('is a no-op for a duplicate refund event delivery (same eventId)', async () => {
        mockWebhookEvent.create.mockRejectedValueOnce({ code: 'P2002' });

        await paymentService.handleRazorpayWebhookEvent(
          {
            event: 'refund.processed',
            payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } } },
          },
          'evt_refund_1'
        );

        expect(mockOrder.updateMany).not.toHaveBeenCalled();
      });

      it('never applies a payment.captured-shaped update for a refund event (no payment entity, order-keyed write)', async () => {
        mockOrder.updateMany.mockResolvedValue({ count: 1 });

        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.processed',
          payload: {
            refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } },
          },
        });

        // Only ever the payment_id-keyed refund write, never the
        // payment_order_id-keyed payment.captured shape.
        expect(mockOrder.updateMany).toHaveBeenCalledTimes(1);
        expect(mockOrder.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ payment_order_id: expect.anything() }) })
        );
      });

      // Fixes the "refund has a failure window" review finding directly:
      // an order stuck at 'paid' (refundOrderPayment's own
      // paymentStatus:'refund_pending' write never landed) is still
      // reconciled here, because the match now goes through the
      // RefundAttempt ledger's own `orderId` rather than requiring Order's
      // own fields to have already been updated.
      it('reconciles an order still stuck at paid — not just refund_pending — when a matching RefundAttempt exists', async () => {
        mockRefundAttempt.findUnique.mockResolvedValueOnce({ id: 'attempt_1', orderId: 'order_1' });
        mockOrder.updateMany.mockResolvedValue({ count: 1 });
        mockOrder.findUnique.mockResolvedValue({
          id: 'order_1',
          orderItems: [{ productId: 'p1', quantity: 2 }],
        });

        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.processed',
          payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } } },
        });

        expect(mockRefundAttempt.findUnique).toHaveBeenCalledWith({ where: { refundId: 'rfnd_1' } });
        expect(mockOrder.updateMany).toHaveBeenCalledWith({
          where: { id: 'order_1', paymentStatus: { in: ['paid', 'refund_pending'] } },
          data: { paymentStatus: 'refunded', status: 'cancelled' },
        });
        expect(mockRefundAttempt.update).toHaveBeenCalledWith({
          where: { id: 'attempt_1' },
          data: { status: 'completed', processedAt: expect.any(Date) },
        });
        expect(inventoryService.restoreStockForOrder).toHaveBeenCalledWith(
          [{ productId: 'p1', quantity: 2 }],
          mockTx
        );
      });

      it('marks the matching RefundAttempt failed too on refund.failed, alongside the order', async () => {
        mockRefundAttempt.findUnique.mockResolvedValueOnce({ id: 'attempt_1', orderId: 'order_1' });
        mockOrder.updateMany.mockResolvedValue({ count: 1 });

        await paymentService.handleRazorpayWebhookEvent({
          event: 'refund.failed',
          payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } } },
        });

        expect(mockOrder.updateMany).toHaveBeenCalledWith({
          where: { id: 'order_1', paymentStatus: { in: ['paid', 'refund_pending'] } },
          data: { paymentStatus: 'refund_failed' },
        });
        expect(mockRefundAttempt.update).toHaveBeenCalledWith({
          where: { id: 'attempt_1' },
          data: { status: 'failed', processedAt: expect.any(Date) },
        });
      });
    });
  });

  describe('refundOrderPayment', () => {
    const paidOrder = (overrides = {}) => ({
      id: 'order_1',
      status: 'confirmed',
      paymentStatus: 'paid',
      payment_id: 'pay_1',
      total: 2499,
      orderItems: [{ productId: 'p1', quantity: 2 }],
      ...overrides,
    });

    beforeEach(() => {
      mockOrder.findUnique.mockReset();
      mockOrder.update.mockReset();
      inventoryService.restoreStockForOrder.mockReset();
      razorpayInstance.payments.refund.mockReset();
    });

    it('throws a 404 if the order does not exist', async () => {
      mockOrder.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(razorpayInstance.payments.refund).not.toHaveBeenCalled();
    });

    it('throws a 400 if the order is not fully paid', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder({ paymentStatus: 'cod_pending' }));

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(razorpayInstance.payments.refund).not.toHaveBeenCalled();
    });

    it('throws a 400 if the order has no recorded payment id', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder({ payment_id: null }));

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws a 400 once the order is already shipped', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder({ status: 'shipped' }));

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(razorpayInstance.payments.refund).not.toHaveBeenCalled();
    });

    // Fixes the "refund failure can create an incorrect business state"
    // review finding: initiating a refund must never itself cancel the
    // order or restore its stock — Razorpay accepting the request only
    // means it started, not that it will succeed. Both only happen once
    // handleRazorpayWebhookEvent's refund.processed branch confirms it did
    // (see that describe block's own tests).
    it('initiates the refund and marks the order refund_pending, without touching status or stock yet', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'processed',
        amount: 249900,
      });
      mockOrder.update.mockResolvedValue({ id: 'order_1', status: 'confirmed', paymentStatus: 'refund_pending' });

      const result = await paymentService.refundOrderPayment(
        'order_1',
        'admin_1',
        'Customer requested cancellation'
      );

      expect(razorpayInstance.payments.refund).toHaveBeenCalledWith('pay_1', {
        notes: { reason: 'Customer requested cancellation' },
      });
      expect(inventoryService.restoreStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: { paymentStatus: 'refund_pending' },
      });
      expect(result.order.status).toBe('confirmed');
      expect(result.refund.id).toBe('rfnd_1');
    });

    // Fixes the "refund has a failure window" review finding: a durable
    // RefundAttempt row must exist BEFORE Razorpay is ever called, so a
    // crash/DB blip at any point afterward still leaves something
    // reconcileUnresolvedRefunds can find its way back to this order with.
    it('creates a durable RefundAttempt row before calling Razorpay, and records the refundId/status once it responds', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'processed',
        amount: 249900,
      });
      mockOrder.update.mockResolvedValue({ id: 'order_1', paymentStatus: 'refund_pending' });

      await paymentService.refundOrderPayment('order_1', 'admin_1', 'Changed my mind');

      expect(mockRefundAttempt.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order_1',
          paymentId: 'pay_1',
          amount: 2499,
          reason: 'Changed my mind',
          requestedBy: 'admin_1',
        },
      });
      // The RefundAttempt create must happen before the real gateway call —
      // otherwise a crash during/after that call leaves nothing durable.
      expect(mockRefundAttempt.create.mock.invocationCallOrder[0]).toBeLessThan(
        razorpayInstance.payments.refund.mock.invocationCallOrder[0]
      );
      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { refundId: 'rfnd_1', status: 'completed', processedAt: expect.any(Date) },
      });
    });

    it("records the attempt as merely 'pending' (not 'completed') when Razorpay's own refund status isn't immediately 'processed'", async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'created',
        amount: 249900,
      });
      mockOrder.update.mockResolvedValue({ id: 'order_1', paymentStatus: 'refund_pending' });

      await paymentService.refundOrderPayment('order_1', 'admin_1');

      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { refundId: 'rfnd_1', status: 'pending', processedAt: null },
      });
    });

    it('marks the RefundAttempt failed (with the real reason) when the gateway rejects the refund', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockRejectedValue({
        statusCode: 400,
        error: { description: 'The id provided does not exist' },
      });

      await expect(paymentService.refundOrderPayment('order_1', 'admin_1')).rejects.toThrow();

      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { status: 'failed', lastError: 'The id provided does not exist' },
      });
    });

    // The actual scenario the "refund has a failure window" finding
    // describes: Razorpay genuinely accepts the refund, and then the local
    // write meant to record that fails. Must never surface as a failure to
    // the admin (that would risk a well-meaning duplicate real refund
    // attempt against a payment already refunded) — the RefundAttempt's
    // own fallback write (and, beyond that, reconcileUnresolvedRefunds) is
    // what's actually relied on to repair this, not this call's own return.
    it('never throws when the local DB write fails after Razorpay already accepted the refund', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'processed',
        amount: 249900,
      });
      // The combined transaction (RefundAttempt + Order update) fails —
      // a plain Error (no `.code`), so withTransactionRetry rethrows
      // immediately rather than retrying (only P2034 is ever retried).
      prisma.$transaction.mockRejectedValueOnce(new Error('DB unreachable'));
      mockOrder.findUnique.mockResolvedValueOnce(paidOrder()).mockResolvedValueOnce({
        id: 'order_1',
        paymentStatus: 'paid', // still stuck — the local write never landed
      });

      const result = await paymentService.refundOrderPayment('order_1', 'admin_1');

      expect(result.refund.id).toBe('rfnd_1');
      expect(result.order.paymentStatus).toBe('paid');
      // The fallback write still records the real refundId even though the
      // order-side update inside the same failed transaction did not land —
      // this is what gives reconcileUnresolvedRefunds something to work
      // from later.
      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { refundId: 'rfnd_1', status: 'completed', processedAt: expect.any(Date) },
      });
    });

    it('does not touch stock or order status when the gateway refund call fails', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockRejectedValue(new Error('gateway down'));

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(inventoryService.restoreStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
    });

    // Confirmed live against Razorpay's real test-mode API: the SDK throws
    // a plain `{ statusCode, error }` object (not an Error instance), so it
    // has no `.message` of its own — surfacing Razorpay's actual reason to
    // the admin depends entirely on refundOrderPayment pulling
    // `error.description` out and putting it on a real Error.
    it("surfaces Razorpay's own error description when the gateway rejects the refund", async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockRejectedValue({
        statusCode: 400,
        error: { description: 'The id provided does not exist' },
      });

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'The id provided does not exist',
      });
    });

    // Razorpay's API gateway 404s (a differently-shaped body with no
    // `error.description`) for some malformed ids rather than the usual
    // 400 "does not exist" — confirmed live. Falls back to a generic but
    // still real message rather than "Something went wrong".
    it('falls back to a generic message when the gateway error has no description', async () => {
      mockOrder.findUnique.mockResolvedValue(paidOrder());
      razorpayInstance.payments.refund.mockRejectedValue({ statusCode: 404 });

      await expect(
        paymentService.refundOrderPayment('order_1', 'admin_1')
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Razorpay was unable to process this refund.',
      });
    });
  });

  describe('handleCODOrder', () => {
    beforeEach(() => {
      mockOrder.findUnique.mockReset();
      mockOrder.update.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      orderService.detectOrderConflicts.mockReset();
      orderService.detectAddressConflict.mockReset();
      orderService.detectPricingConflict.mockReset();
      // Default: no drift since the draft order was created, and the
      // delivery address is still around — matches the pre-existing
      // fixtures below, which weren't written with a price/stock/address/
      // pricing conflict in mind.
      orderService.detectOrderConflicts.mockResolvedValue([]);
      orderService.detectAddressConflict.mockResolvedValue([]);
      orderService.detectPricingConflict.mockReturnValue([]);
      cartQueue.add.mockReset();
      prisma.$transaction.mockClear();
    });

    it('throws a 404 if the order does not exist', async () => {
      mockOrder.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws a 403 if the order doesn't belong to the requesting user", async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'someone_else',
        status: 'draft',
        orderItems: [],
      });

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('is idempotent for an order that was already placed', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        status: 'confirmed',
        orderItems: [],
      });

      const result = await paymentService.handleCODOrder('order_1', 'user_1');

      expect(result.alreadyProcessed).toBe(true);
      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    it('reserves stock, confirms the order, and clears the cart on a fresh COD order', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        addressId: 'addr_1',
        status: 'draft',
        orderItems: [{ productId: 'p1', quantity: 1 }],
      });
      inventoryService.decrementStockForOrder.mockResolvedValue([]);
      mockOrder.update.mockResolvedValue({
        id: 'order_1',
        status: 'confirmed',
        paymentStatus: 'cod_pending',
      });

      const result = await paymentService.handleCODOrder('order_1', 'user_1');

      expect(result.alreadyProcessed).toBe(false);
      expect(orderService.detectAddressConflict).toHaveBeenCalledWith(
        'addr_1',
        'user_1',
        mockTx,
        'COD'
      );
      expect(orderService.detectOrderConflicts).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 1 }],
        mockTx
      );
      expect(inventoryService.decrementStockForOrder).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 1 }],
        mockTx
      );
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          paymentStatus: 'cod_pending',
          status: 'confirmed',
          payment_order_id: 'cod-order_1',
        },
      });
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
      // COD's own stock reservation already happened transactionally above
      // (decrementStock: false for runFulfillment) — this is just the
      // fulfillment-tracking write for the cart-clear/notification step.
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          fulfillmentAttempts: { increment: 1 },
          fulfillmentStatus: 'completed',
          fulfillmentError: null,
        },
      });
    });

    it('rolls back (no order confirmation, no cart clear) when stock is insufficient', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        status: 'draft',
        orderItems: [{ productId: 'p1', quantity: 99 }],
      });
      const CustomError = require('@utils/customError');
      inventoryService.decrementStockForOrder.mockRejectedValue(
        new CustomError(
          'Insufficient stock for one or more items in this order',
          409
        )
      );

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(mockOrder.update).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    // Price/stock conflict detection — see order.service.js's
    // detectOrderConflicts. This runs before the atomic stock decrement, so
    // it's the path that actually fires for a drifted draft order in
    // practice (the decrement-time 409 above is the final race-condition
    // backstop, not the primary way a stale COD order gets caught).
    it('409s with the structured conflicts and never reserves stock or confirms when the order has drifted since it was created', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        status: 'draft',
        orderItems: [{ productId: 'p1', quantity: 1, price: 999 }],
      });
      orderService.detectOrderConflicts.mockResolvedValue([
        {
          productId: 'p1',
          name: 'Running Shoe',
          type: 'price_changed',
          orderedPrice: 999,
          currentPrice: 1099,
          message:
            'The price of this item has changed since it was added to your order.',
        },
      ]);

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: {
          conflicts: [
            expect.objectContaining({ productId: 'p1', type: 'price_changed' }),
          ],
        },
      });

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    // Address deletion — see order.service.js's detectAddressConflict. No
    // money has moved yet for COD, so this has to be caught before stock is
    // reserved, same reasoning as the price/stock conflict case above.
    it('409s with an address_unavailable conflict and never reserves stock or confirms when the delivery address has been deleted', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        addressId: 'addr_deleted',
        status: 'draft',
        orderItems: [{ productId: 'p1', quantity: 1, price: 999 }],
      });
      orderService.detectAddressConflict.mockResolvedValue([
        {
          type: 'address_unavailable',
          message:
            'The delivery address for this order is no longer available. Please choose a different address.',
        },
      ]);

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: {
          conflicts: [expect.objectContaining({ type: 'address_unavailable' })],
        },
      });

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    // Delivery-charge/total drift — see order.service.js's
    // detectPricingConflict. Covers an env-level pricing config change
    // (FREE_DELIVERY_THRESHOLD/DELIVERY_CHARGE) since the draft order was
    // created, which item price/stock checks alone would never catch.
    it('409s with a pricing_changed conflict and never reserves stock or confirms when the delivery charge/total has drifted', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        status: 'draft',
        subtotal: 398,
        deliveryCharge: 49,
        discount: 0,
        total: 447,
        orderItems: [{ productId: 'p1', quantity: 1, price: 199 }],
      });
      orderService.detectPricingConflict.mockReturnValue([
        {
          type: 'pricing_changed',
          message:
            'The delivery charge or total for this order has changed. Please refresh your order before proceeding.',
          previousTotal: 447,
          currentTotal: 398,
        },
      ]);

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: {
          conflicts: [expect.objectContaining({ type: 'pricing_changed' })],
        },
      });

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('cancelPaymentAttempt', () => {
    beforeEach(() => {
      mockOrder.findUnique.mockReset();
      mockOrder.updateMany.mockReset();
    });

    it('throws a 404 if the order does not exist', async () => {
      mockOrder.findUnique.mockResolvedValue(null);

      await expect(
        paymentService.cancelPaymentAttempt('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("throws a 403 if the order doesn't belong to the requesting user", async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'someone_else',
        status: 'draft',
      });

      await expect(
        paymentService.cancelPaymentAttempt('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws a 409 if the order is no longer awaiting payment', async () => {
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        userId: 'user_1',
        status: 'confirmed',
      });

      await expect(
        paymentService.cancelPaymentAttempt('order_1', 'user_1')
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('cancels an in-flight attempt and reports cancelled: true', async () => {
      mockOrder.findUnique
        .mockResolvedValueOnce({
          id: 'order_1',
          userId: 'user_1',
          status: 'draft',
        })
        .mockResolvedValueOnce({
          id: 'order_1',
          userId: 'user_1',
          status: 'draft',
          paymentStatus: 'cancelled',
        });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      const result = await paymentService.cancelPaymentAttempt(
        'order_1',
        'user_1'
      );

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order_1',
          paymentStatus: { in: ['pending', 'attempted', 'processing'] },
        },
        data: { paymentStatus: 'cancelled' },
      });
      expect(result.cancelled).toBe(true);
    });

    it('is idempotent — a repeat call for an already-resolved attempt reports cancelled: false', async () => {
      mockOrder.findUnique
        .mockResolvedValueOnce({
          id: 'order_1',
          userId: 'user_1',
          status: 'draft',
          paymentStatus: 'cancelled',
        })
        .mockResolvedValueOnce({
          id: 'order_1',
          userId: 'user_1',
          status: 'draft',
          paymentStatus: 'cancelled',
        });
      mockOrder.updateMany.mockResolvedValue({ count: 0 });

      const result = await paymentService.cancelPaymentAttempt(
        'order_1',
        'user_1'
      );

      expect(result.cancelled).toBe(false);
    });
  });

  describe('reconcileStalePaymentAttempts', () => {
    beforeEach(() => {
      mockOrder.findMany.mockReset();
      mockOrder.updateMany.mockReset();
      razorpayInstance.orders.create.mockReset();
    });

    it('marks a stale, never-captured attempt as timeout', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          payment_order_id: 'rzp_order_1',
          paymentStatus: 'attempted',
        },
      ]);
      jest.spyOn(paymentService, 'fetchRazorpayOrder').mockResolvedValue({
        id: 'rzp_order_1',
        status: 'created',
      });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      const results = await paymentService.reconcileStalePaymentAttempts();

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order_1',
          paymentStatus: { in: ['pending', 'attempted', 'processing'] },
        },
        data: { paymentStatus: 'timeout' },
      });
      expect(results).toEqual({ timedOut: 1, reconciledPaid: 0, unknown: 0 });
    });

    it('reconciles a stale attempt Razorpay actually captured, instead of timing out real money', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          payment_order_id: 'rzp_order_1',
          paymentStatus: 'attempted',
        },
      ]);
      jest.spyOn(paymentService, 'fetchRazorpayOrder').mockResolvedValue({
        id: 'rzp_order_1',
        status: 'paid',
      });
      jest
        .spyOn(paymentService, 'fetchOrderPayments')
        .mockResolvedValue([{ id: 'pay_1', status: 'captured' }]);
      const updateSpy = jest
        .spyOn(paymentService, 'updateOrderAfterPayment')
        .mockResolvedValue({
          order: { id: 'order_1' },
          alreadyProcessed: false,
        });

      const results = await paymentService.reconcileStalePaymentAttempts();

      expect(updateSpy).toHaveBeenCalledWith('rzp_order_1', 'pay_1');
      expect(results).toEqual({ timedOut: 0, reconciledPaid: 1, unknown: 0 });
    });

    it('marks an attempt unknown rather than guessing when Razorpay cannot be reached', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          payment_order_id: 'rzp_order_1',
          paymentStatus: 'attempted',
        },
      ]);
      jest.spyOn(paymentService, 'fetchRazorpayOrder').mockResolvedValue(null);
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      const results = await paymentService.reconcileStalePaymentAttempts();

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order_1',
          paymentStatus: { in: ['pending', 'attempted', 'processing'] },
        },
        data: { paymentStatus: 'unknown' },
      });
      expect(results).toEqual({ timedOut: 0, reconciledPaid: 0, unknown: 1 });
    });

    it('is a no-op when nothing is stale', async () => {
      mockOrder.findMany.mockResolvedValue([]);

      const results = await paymentService.reconcileStalePaymentAttempts();

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
      expect(results).toEqual({ timedOut: 0, reconciledPaid: 0, unknown: 0 });
    });
  });

  // The actual retry mechanism behind runFulfillment's 'failed' orders —
  // see the "paid-order fulfillment can fail permanently" review finding.
  describe('reconcileFailedFulfillments', () => {
    beforeEach(() => {
      mockOrder.findMany.mockReset();
      mockOrder.update.mockReset();
      mockOrder.findUnique.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      cartQueue.add.mockReset();
      notificationQueue.add.mockReset();
    });

    it('queries only orders below MAX_FULFILLMENT_ATTEMPTS, and retries each one', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          userId: 'user_1',
          paymentStatus: 'paid',
          orderItems: [{ productId: 'p1', quantity: 1 }],
          stockDecremented: false,
          oversold: false,
        },
      ]);
      inventoryService.decrementStockForOrder.mockResolvedValue([]);
      mockOrder.findUnique.mockResolvedValue({ fulfillmentStatus: 'completed' });

      const results = await paymentService.reconcileFailedFulfillments();

      expect(mockOrder.findMany).toHaveBeenCalledWith({
        where: { fulfillmentStatus: 'failed', fulfillmentAttempts: { lt: 5 } },
        include: { orderItems: true },
      });
      expect(inventoryService.decrementStockForOrder).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 1 }],
        mockTx,
        { throwOnInsufficientStock: false }
      );
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
      expect(results).toEqual({ retried: 1, recovered: 1, stillFailing: 0 });
    });

    it('does not re-decrement stock for an order whose decrement already ran once', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          userId: 'user_1',
          paymentStatus: 'paid',
          orderItems: [{ productId: 'p1', quantity: 1 }],
          stockDecremented: true,
          oversold: false,
        },
      ]);
      mockOrder.findUnique.mockResolvedValue({ fulfillmentStatus: 'completed' });

      await paymentService.reconcileFailedFulfillments();

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
    });

    it('never retries stock decrement for a COD order — it already reserved stock transactionally', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          userId: 'user_1',
          paymentStatus: 'cod_pending',
          orderItems: [{ productId: 'p1', quantity: 1 }],
          stockDecremented: false,
          oversold: false,
        },
      ]);
      mockOrder.findUnique.mockResolvedValue({ fulfillmentStatus: 'completed' });

      await paymentService.reconcileFailedFulfillments();

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
    });

    it('keeps a genuinely oversold order as stillFailing even once cart/notification succeed', async () => {
      mockOrder.findMany.mockResolvedValue([
        {
          id: 'order_1',
          userId: 'user_1',
          paymentStatus: 'paid',
          orderItems: [{ productId: 'p1', quantity: 1 }],
          stockDecremented: true,
          oversold: true,
        },
      ]);
      mockOrder.findUnique.mockResolvedValue({ fulfillmentStatus: 'failed' });

      const results = await paymentService.reconcileFailedFulfillments();

      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: {
          fulfillmentAttempts: { increment: 1 },
          fulfillmentStatus: 'failed',
          fulfillmentError:
            'Paid but oversold — insufficient stock for one or more items in this order.',
        },
      });
      expect(results).toEqual({ retried: 1, recovered: 0, stillFailing: 1 });
    });

    it('is a no-op when nothing is failing', async () => {
      mockOrder.findMany.mockResolvedValue([]);

      const results = await paymentService.reconcileFailedFulfillments();

      expect(cartQueue.add).not.toHaveBeenCalled();
      expect(results).toEqual({ retried: 0, recovered: 0, stillFailing: 0 });
    });
  });

  // The actual repair mechanism behind the "refund has a failure window"
  // review finding: a RefundAttempt left 'initiated'/'pending' past a
  // grace period gets asked about directly, using its own durable
  // orderId/paymentId rather than trusting Order's own fields to have
  // been successfully updated.
  describe('reconcileUnresolvedRefunds', () => {
    beforeEach(() => {
      mockRefundAttempt.findMany.mockReset();
      mockRefundAttempt.update.mockReset().mockResolvedValue({});
      mockOrder.updateMany.mockReset();
      mockOrder.findUnique.mockReset();
      inventoryService.restoreStockForOrder.mockReset();
      razorpayInstance.payments.fetchRefund.mockReset();
      razorpayInstance.payments.fetchMultipleRefund.mockReset();
    });

    it('reconciles a genuinely completed refund: cancels the order and restores stock', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([
        { id: 'attempt_1', orderId: 'order_1', paymentId: 'pay_1', refundId: 'rfnd_1' },
      ]);
      razorpayInstance.payments.fetchRefund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'processed',
        amount: 249900,
      });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({
        id: 'order_1',
        orderItems: [{ productId: 'p1', quantity: 2 }],
      });

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(razorpayInstance.payments.fetchRefund).toHaveBeenCalledWith('pay_1', 'rfnd_1');
      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'order_1', paymentStatus: { in: ['paid', 'refund_pending'] } },
        data: { paymentStatus: 'refunded', status: 'cancelled' },
      });
      expect(inventoryService.restoreStockForOrder).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 2 }],
        mockTx
      );
      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { refundId: 'rfnd_1', status: 'completed', processedAt: expect.any(Date) },
      });
      expect(results).toEqual({ checked: 1, completed: 1, failed: 0, stillPending: 0, unknown: 0 });
    });

    it('reconciles a genuinely failed refund: marks the order refund_failed, never touches stock', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([
        { id: 'attempt_1', orderId: 'order_1', paymentId: 'pay_1', refundId: 'rfnd_1' },
      ]);
      razorpayInstance.payments.fetchRefund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'failed',
        amount: 249900,
      });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'order_1', paymentStatus: { in: ['paid', 'refund_pending'] } },
        data: { paymentStatus: 'refund_failed' },
      });
      expect(inventoryService.restoreStockForOrder).not.toHaveBeenCalled();
      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { refundId: 'rfnd_1', status: 'failed', processedAt: expect.any(Date) },
      });
      expect(results.failed).toBe(1);
    });

    it('leaves a still-genuinely-pending refund alone', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([
        { id: 'attempt_1', orderId: 'order_1', paymentId: 'pay_1', refundId: 'rfnd_1' },
      ]);
      razorpayInstance.payments.fetchRefund.mockResolvedValue({
        id: 'rfnd_1',
        payment_id: 'pay_1',
        status: 'created',
        amount: 249900,
      });

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
      expect(results.stillPending).toBe(1);
    });

    // The rarer double-failure case: refundOrderPayment's own follow-up
    // write never even recorded the refundId Razorpay assigned.
    it('falls back to listing refunds for the payment when the attempt never recorded a refundId', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([
        { id: 'attempt_1', orderId: 'order_1', paymentId: 'pay_1', refundId: null },
      ]);
      razorpayInstance.payments.fetchMultipleRefund.mockResolvedValue({
        items: [{ id: 'rfnd_1', payment_id: 'pay_1', status: 'processed', amount: 249900 }],
      });
      mockOrder.updateMany.mockResolvedValue({ count: 1 });
      mockOrder.findUnique.mockResolvedValue({ id: 'order_1', orderItems: [] });

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(razorpayInstance.payments.fetchRefund).not.toHaveBeenCalled();
      expect(razorpayInstance.payments.fetchMultipleRefund).toHaveBeenCalledWith('pay_1');
      expect(results.completed).toBe(1);
    });

    it('marks the attempt unknown when Razorpay cannot confirm anything either way', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([
        { id: 'attempt_1', orderId: 'order_1', paymentId: 'pay_1', refundId: 'rfnd_1' },
      ]);
      razorpayInstance.payments.fetchRefund.mockRejectedValue(new Error('network down'));

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(mockRefundAttempt.update).toHaveBeenCalledWith({
        where: { id: 'attempt_1' },
        data: { status: 'unknown' },
      });
      expect(mockOrder.updateMany).not.toHaveBeenCalled();
      expect(results.unknown).toBe(1);
    });

    it('only queries attempts still initiated/pending past the staleness window', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([]);

      await paymentService.reconcileUnresolvedRefunds();

      expect(mockRefundAttempt.findMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['initiated', 'pending'] },
          requestedAt: { lt: expect.any(Date) },
        },
      });
    });

    it('is a no-op when nothing is unresolved', async () => {
      mockRefundAttempt.findMany.mockResolvedValue([]);

      const results = await paymentService.reconcileUnresolvedRefunds();

      expect(razorpayInstance.payments.fetchRefund).not.toHaveBeenCalled();
      expect(results).toEqual({ checked: 0, completed: 0, failed: 0, stillPending: 0, unknown: 0 });
    });
  });
});
