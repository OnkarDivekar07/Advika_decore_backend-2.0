// tests/unit/clearCartWorker.test.js
//
// Pattern 16 (Redis/BullMQ/background-job resilience audit): clearCartWorker
// had no dedicated test anywhere — cart-clearing is only ever exercised
// indirectly through payment.service.js's own tests, which mock the queue
// itself (`cartQueue.add`) rather than the worker that actually processes
// the job. This closes that gap directly, same mocking style as
// imageWorker.test.js: mock bullmq's Worker to capture the real processor
// function and invoke it directly, no live Redis needed.
const MockWorker = jest.fn().mockImplementation((name, processor) => ({
  name,
  processor,
  on: jest.fn(),
}));
jest.mock('bullmq', () => ({ Worker: MockWorker }));
jest.mock('@config/redis', () => ({}));

const mockPrisma = {
  cart: { deleteMany: jest.fn() },
};
jest.mock('@config/prisma', () => mockPrisma);

require('../../src/jobs/workers/clearCartWorker');
const processor = MockWorker.mock.calls[0][1];

describe('clearCartWorker', () => {
  beforeEach(() => {
    mockPrisma.cart.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it('throws when userId is missing, rather than clearing every cart', async () => {
    await expect(processor({ data: {} })).rejects.toThrow('Missing userId');
    expect(mockPrisma.cart.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes exactly this user\'s cart', async () => {
    const result = await processor({ data: { userId: 'u1' } });

    expect(mockPrisma.cart.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(result).toEqual({ message: 'Cart with userId u1 cleared' });
  });

  // The actual "repeated job execution" / "worker crash/restart" guard for
  // this queue: a BullMQ retry or a stalled-job redelivery re-runs this
  // same handler from scratch, so it must never fail or behave differently
  // just because the cart was already cleared by an earlier attempt.
  it('is a safe no-op when run again against an already-cleared cart', async () => {
    mockPrisma.cart.deleteMany.mockResolvedValue({ count: 0 });

    const result = await processor({ data: { userId: 'u1' } });

    expect(result).toEqual({ message: 'Cart with userId u1 cleared' });
  });
});
