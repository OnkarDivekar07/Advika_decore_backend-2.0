// tests/unit/notificationWorker.test.js
//
// Pattern 16 (Redis/BullMQ/background-job resilience audit): had zero test
// coverage anywhere — neither this worker nor notification.service.js had
// a dedicated test file. The branching here is the actual safety mechanism
// against "repeated/stale job execution" for order-confirmation SMS: the
// worker re-fetches the order fresh and only sends if it's *currently*
// 'confirmed', rather than trusting whatever it was at enqueue time — see
// this file's own header comment for why (a job that sits in the queue
// through a Redis hiccup/worker restart, or a webhook retry re-queuing
// after the order was reconciled and since cancelled some other way, must
// never blindly fire a stale notification).
const MockWorker = jest.fn().mockImplementation((name, processor) => ({
  name,
  processor,
  on: jest.fn(),
}));
jest.mock('bullmq', () => ({ Worker: MockWorker }));
jest.mock('@config/redis', () => ({}));

const mockPrisma = {
  order: { findUnique: jest.fn() },
};
jest.mock('@config/prisma', () => mockPrisma);

const mockSendOrderConfirmationSms = jest.fn();
jest.mock('@modules/notification/notification.service', () => ({
  sendOrderConfirmationSms: (...args) => mockSendOrderConfirmationSms(...args),
}));

require('../../src/jobs/workers/notificationWorker');
const processor = MockWorker.mock.calls[0][1];

describe('notificationWorker', () => {
  beforeEach(() => {
    mockPrisma.order.findUnique.mockReset();
    mockSendOrderConfirmationSms.mockReset().mockResolvedValue({ sent: true });
  });

  it('rejects an unknown job name', async () => {
    await expect(
      processor({ name: 'something-else', data: {} })
    ).rejects.toThrow('Unknown notification job: something-else');
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('throws when orderId is missing', async () => {
    await expect(
      processor({ name: 'order-confirmation', data: {} })
    ).rejects.toThrow('Missing orderId');
  });

  it('skips (does not throw, does not send) when the order no longer exists', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);

    const result = await processor({
      name: 'order-confirmation',
      data: { orderId: 'o1' },
    });

    expect(result).toEqual({ sent: false, reason: 'order_not_found' });
    expect(mockSendOrderConfirmationSms).not.toHaveBeenCalled();
  });

  // The core stale-job guard: re-checks the order's *current* status
  // rather than trusting the caller's state from enqueue time.
  it('skips sending when the order is no longer confirmed (e.g. cancelled since this job was enqueued)', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: 'cancelled',
      paymentStatus: 'refunded',
      total: 500,
      user: { phone: '+919876543210' },
    });

    const result = await processor({
      name: 'order-confirmation',
      data: { orderId: 'o1' },
    });

    expect(result).toEqual({ sent: false, reason: 'not_confirmed' });
    expect(mockSendOrderConfirmationSms).not.toHaveBeenCalled();
  });

  it('sends with paymentMethod "cod" for a cod_pending order', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: 'confirmed',
      paymentStatus: 'cod_pending',
      total: 500,
      user: { phone: '+919876543210' },
    });

    await processor({ name: 'order-confirmation', data: { orderId: 'o1' } });

    expect(mockSendOrderConfirmationSms).toHaveBeenCalledWith({
      phone: '+919876543210',
      orderId: 'o1',
      total: 500,
      paymentMethod: 'cod',
    });
  });

  it('sends with paymentMethod "online" for a paid order', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: 'confirmed',
      paymentStatus: 'paid',
      total: 999,
      user: { phone: '+919876543210' },
    });

    const result = await processor({
      name: 'order-confirmation',
      data: { orderId: 'o1' },
    });

    expect(mockSendOrderConfirmationSms).toHaveBeenCalledWith({
      phone: '+919876543210',
      orderId: 'o1',
      total: 999,
      paymentMethod: 'online',
    });
    expect(result).toEqual({ sent: true });
  });
});
