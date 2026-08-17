const mockRedis = {
  incr: jest.fn(),
  expire: jest.fn(),
};

jest.mock('@config/redis', () => mockRedis);

const { createRateLimiter, adminLoginRateLimiter } = require('@middlewares/rateLimiter');

const buildReqRes = (phone) => ({
  req: { body: { phone } },
  res: {},
  next: jest.fn(),
});

describe('rateLimiter.createRateLimiter', () => {
  const limiter = createRateLimiter({
    prefix: 'test-limit',
    maxAttempts: 5,
    windowSeconds: 60,
    message: 'Too many requests.',
  });

  it('keys on the normalized phone number, not the raw string', async () => {
    mockRedis.incr.mockResolvedValue(1);

    const { req, res, next } = buildReqRes('+919999999999');
    await limiter(req, res, next);

    expect(mockRedis.incr).toHaveBeenCalledWith('test-limit:9999999999');
    expect(next).toHaveBeenCalledWith();
  });

  it('treats formatting variants of the same number as the same rate-limit bucket (regression: whitespace/prefix bypass)', async () => {
    mockRedis.incr.mockResolvedValue(1);

    const variants = ['+919999999999', '+91 9999999999', ' +919999999999', '919999999999', '9999999999'];

    for (const phone of variants) {
      const { req, res, next } = buildReqRes(phone);
      await limiter(req, res, next);
    }

    // Every variant above normalizes to the same 10-digit number, so they
    // must all hit the exact same Redis key — otherwise each formatting
    // variant gets its own attempt budget, defeating the limiter.
    const keysUsed = new Set(mockRedis.incr.mock.calls.map(([key]) => key));
    expect(keysUsed.size).toBe(1);
    expect(keysUsed.has('test-limit:9999999999')).toBe(true);
  });

  it('blocks once maxAttempts is exceeded, regardless of which formatting variant tips it over', async () => {
    mockRedis.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6);

    const attempts = [
      '+919999999999',
      '+91 9999999999',
      '+919999999999',
      '+91 9999999999',
      '+919999999999',
      '+91 9999999999', // 6th attempt, still same underlying number
    ];

    let lastNext;
    for (const phone of attempts) {
      const { req, res, next } = buildReqRes(phone);
      await limiter(req, res, next);
      lastNext = next;
    }

    expect(lastNext).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Too many requests.', statusCode: 429 })
    );
  });

  it('falls back to an "invalid" bucket rather than throwing when phone is missing/malformed', async () => {
    mockRedis.incr.mockResolvedValue(1);

    const { req, res, next } = buildReqRes(undefined);
    await limiter(req, res, next);

    expect(mockRedis.incr).toHaveBeenCalledWith('test-limit:invalid');
    expect(next).toHaveBeenCalledWith();
  });

  it('sets an expiry only on the first request in a window', async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    const first = buildReqRes('+919999999999');
    await limiter(first.req, first.res, first.next);
    expect(mockRedis.expire).toHaveBeenCalledWith('test-limit:9999999999', 60);

    mockRedis.expire.mockClear();
    mockRedis.incr.mockResolvedValueOnce(2);
    const second = buildReqRes('+919999999999');
    await limiter(second.req, second.res, second.next);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  describe('keyBy option', () => {
    it('keys on whatever keyBy(req) returns instead of req.body.phone', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const custom = createRateLimiter({
        prefix: 'custom-limit',
        keyBy: (req) => req.body.email,
      });

      const req = { body: { email: 'Admin@Example.com' } };
      const next = jest.fn();
      await custom(req, {}, next);

      expect(mockRedis.incr).toHaveBeenCalledWith('custom-limit:Admin@Example.com');
      expect(next).toHaveBeenCalledWith();
    });

    it('falls back to an "invalid" bucket when keyBy returns an empty value', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const custom = createRateLimiter({
        prefix: 'custom-limit',
        keyBy: (req) => req.body.email,
      });

      const req = { body: {} };
      const next = jest.fn();
      await custom(req, {}, next);

      expect(mockRedis.incr).toHaveBeenCalledWith('custom-limit:invalid');
    });
  });

  describe('adminLoginRateLimiter', () => {
    it('keys on the lowercased, trimmed email', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const req = { body: { email: '  Admin@Advika.com  ', password: 'x' } };
      const next = jest.fn();

      await adminLoginRateLimiter(req, {}, next);

      expect(mockRedis.incr).toHaveBeenCalledWith('admin-login-limit:admin@advika.com');
      expect(next).toHaveBeenCalledWith();
    });

    it('429s once the per-email attempt cap is exceeded', async () => {
      mockRedis.incr.mockResolvedValue(11); // maxAttempts is 10
      const req = { body: { email: 'admin@advika.com', password: 'x' } };
      const next = jest.fn();

      await adminLoginRateLimiter(req, {}, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Too many login attempts. Please try again later.',
          statusCode: 429,
        })
      );
    });
  });
});
