const crypto = require('crypto');

// --- Mocks -------------------------------------------------------------
// Razorpay SDK: never hit the network. Capture the constructed instance so
// individual tests can control what orders.create() resolves/rejects with.
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
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
};
const mockTx = { order: mockOrder };

jest.mock('@config/prisma', () => ({
  order: mockOrder,
  $transaction: jest.fn(async (cb) => cb(mockTx)),
}));

jest.mock('@modules/inventory/inventory.service', () => ({
  decrementStockForOrder: jest.fn(),
}));

jest.mock('@modules/order/order.service', () => ({
  detectOrderConflicts: jest.fn(),
  detectAddressConflict: jest.fn(),
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

    const sign = (orderId, paymentId, secret = process.env.RAZORPAY_KEY_SECRET) =>
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
      const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
      const signature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

      expect(paymentService.verifyWebhookSignature(rawBody, signature)).toBe(
        true
      );
    });

    it('returns false if the body was modified after signing', () => {
      const original = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
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
      mockOrder.update.mockReset();
    });

    it('creates a Razorpay order and stashes the id on our order', async () => {
      razorpayInstance.orders.create.mockResolvedValue({
        id: 'rzp_order_1',
        amount: 50000,
      });
      mockOrder.update.mockResolvedValue({});

      const result = await paymentService.createRazorpayOrder({
        amount: 50000,
        receipt: 'order_1',
        order_id: 'order_1',
      });

      expect(result).toEqual({ id: 'rzp_order_1', amount: 50000 });
      expect(mockOrder.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: { payment_order_id: 'rzp_order_1' },
      });
    });

    it('wraps a Razorpay failure in a 500 CustomError', async () => {
      razorpayInstance.orders.create.mockRejectedValue(new Error('network down'));

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
      expect(inventoryService.decrementStockForOrder).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 2 }],
        prisma,
        { throwOnInsufficientStock: false }
      );
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
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
  });

  describe('handleRazorpayWebhookEvent', () => {
    beforeEach(() => {
      mockOrder.updateMany.mockReset();
      mockOrder.findUnique.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      cartQueue.add.mockReset();
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
        payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } } },
      });

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: { payment_order_id: 'rzp_order_1', paymentStatus: { not: 'paid' } },
        data: { paymentStatus: 'paid', status: 'confirmed', payment_id: 'pay_1' },
      });
      expect(cartQueue.add).toHaveBeenCalledWith('clear-cart', {
        userId: 'user_1',
      });
    });

    it('does not re-apply side effects for a duplicate payment.captured delivery', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 0 });

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } } },
      });

      expect(mockOrder.findUnique).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });

    it('marks the order failed on payment.failed, but only if not already paid', async () => {
      mockOrder.updateMany.mockResolvedValue({ count: 1 });

      await paymentService.handleRazorpayWebhookEvent({
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } } },
      });

      expect(mockOrder.updateMany).toHaveBeenCalledWith({
        where: { payment_order_id: 'rzp_order_1', paymentStatus: { not: 'paid' } },
        data: { paymentStatus: 'failed', payment_id: 'pay_1' },
      });
    });

    it('acks unhandled event types without touching the order', async () => {
      await paymentService.handleRazorpayWebhookEvent({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } } },
      });

      expect(mockOrder.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('handleCODOrder', () => {
    beforeEach(() => {
      mockOrder.findUnique.mockReset();
      mockOrder.update.mockReset();
      inventoryService.decrementStockForOrder.mockReset();
      orderService.detectOrderConflicts.mockReset();
      orderService.detectAddressConflict.mockReset();
      // Default: no drift since the draft order was created, and the
      // delivery address is still around — matches the pre-existing
      // fixtures below, which weren't written with a price/stock/address
      // conflict in mind.
      orderService.detectOrderConflicts.mockResolvedValue([]);
      orderService.detectAddressConflict.mockResolvedValue([]);
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
        mockTx
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
        new CustomError('Insufficient stock for one or more items in this order', 409)
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
          message: 'The price of this item has changed since it was added to your order.',
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
          message: 'The delivery address for this order is no longer available. Please choose a different address.',
        },
      ]);

      await expect(
        paymentService.handleCODOrder('order_1', 'user_1')
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: {
          conflicts: [
            expect.objectContaining({ type: 'address_unavailable' }),
          ],
        },
      });

      expect(inventoryService.decrementStockForOrder).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
      expect(cartQueue.add).not.toHaveBeenCalled();
    });
  });
});
