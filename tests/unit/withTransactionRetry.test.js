const mockPrisma = { $transaction: jest.fn() };
jest.mock('@config/prisma', () => mockPrisma);

const withTransactionRetry = require('@utils/withTransactionRetry');

describe('withTransactionRetry', () => {
  beforeEach(() => {
    mockPrisma.$transaction.mockReset();
  });

  it('returns the transaction result on a normal, non-conflicting run', async () => {
    mockPrisma.$transaction.mockResolvedValue({ id: 'order_1' });

    const result = await withTransactionRetry(async (tx) => tx.order.create());

    expect(result).toEqual({ id: 'order_1' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('retries once on a P2034 write-conflict error, and succeeds on the retry', async () => {
    mockPrisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034', message: 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction' })
      .mockResolvedValueOnce({ id: 'order_1' });

    const result = await withTransactionRetry(async (tx) => tx.order.create());

    expect(result).toEqual({ id: 'order_1' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up and rethrows after exhausting every attempt, still P2034', async () => {
    mockPrisma.$transaction.mockRejectedValue({ code: 'P2034', message: 'write conflict' });

    await expect(withTransactionRetry(async (tx) => tx.order.create())).rejects.toMatchObject({
      code: 'P2034',
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('never retries a real CustomError-shaped rejection — rethrows immediately', async () => {
    mockPrisma.$transaction.mockRejectedValue({ statusCode: 409, message: 'Insufficient stock' });

    await expect(withTransactionRetry(async (tx) => tx.order.create())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('never retries a plain unrelated error — rethrows immediately', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('Something else broke'));

    await expect(withTransactionRetry(async (tx) => tx.order.create())).rejects.toThrow(
      'Something else broke'
    );
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('forwards the callback and any transaction options straight through to prisma.$transaction', async () => {
    mockPrisma.$transaction.mockResolvedValue('ok');
    const callback = jest.fn();
    const options = { maxWait: 5000, timeout: 10000 };

    await withTransactionRetry(callback, options);

    expect(mockPrisma.$transaction).toHaveBeenCalledWith(callback, options);
  });
});
