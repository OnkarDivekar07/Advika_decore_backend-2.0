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

  it('gives up after exhausting every attempt and surfaces a clean 409, not the raw Prisma error', async () => {
    mockPrisma.$transaction.mockRejectedValue({ code: 'P2034', message: 'write conflict' });

    await expect(withTransactionRetry(async (tx) => tx.order.create())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('high demand'),
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(10);
  }, 15000);

  it('retries a P2028 transaction-timeout error (real interactive-transaction expiry under heavy contention), and succeeds on the retry', async () => {
    mockPrisma.$transaction
      .mockRejectedValueOnce({
        code: 'P2028',
        message:
          "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5013 ms passed since the start of the transaction.",
      })
      .mockResolvedValueOnce({ id: 'order_1' });

    const result = await withTransactionRetry(async (tx) => tx.order.create());

    expect(result).toEqual({ id: 'order_1' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-timeout P2028 (e.g. a transaction already committed, or an invalid/stale reference) — rethrows immediately', async () => {
    mockPrisma.$transaction.mockRejectedValue({
      code: 'P2028',
      message: 'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
    });

    await expect(withTransactionRetry(async (tx) => tx.order.create())).rejects.toMatchObject({
      code: 'P2028',
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  // Pattern 10 (concurrency audit): found live by firing two genuinely
  // simultaneous, identically-signed Razorpay webhook deliveries at the
  // real E2E backend — MongoDB aborted the losing transaction over a write
  // conflict, but Prisma only threw on the NEXT operation in that same
  // transaction, as this exact P2028 "has been aborted" shape rather than
  // the P2034 write-conflict code or the "already closed"/expired-timeout
  // P2028 wording already handled above. Without this, one of the two
  // deliveries surfaced as an unhandled 500 instead of gracefully
  // resolving to a deduped no-op on retry.
  it('retries a P2028 transaction-aborted error (a losing side of a real write conflict, surfaced on a later operation in the same transaction), and succeeds on the retry', async () => {
    mockPrisma.$transaction
      .mockRejectedValueOnce({
        code: 'P2028',
        message: 'Transaction API error: Transaction with { txnNumber: 47 } has been aborted.',
      })
      .mockResolvedValueOnce({ id: 'order_1' });

    const result = await withTransactionRetry(async (tx) => tx.order.create());

    expect(result).toEqual({ id: 'order_1' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
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
