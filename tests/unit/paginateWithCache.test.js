const mockRedis = { get: jest.fn(), set: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

const paginateWithCache = require('@utils/paginateWithCache');

const buildModel = (data = [], total = 0) => ({
  count: jest.fn().mockResolvedValue(total),
  findMany: jest.fn().mockResolvedValue(data),
});

describe('paginateWithCache', () => {
  beforeEach(() => {
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.get.mockResolvedValue(null);
  });

  it('produces different cache keys for different cacheKeyExtra values', async () => {
    const model = buildModel([{ id: 'p1' }], 1);

    await paginateWithCache({
      model,
      req: { query: {} },
      cachePrefix: 'allProducts',
      cacheKeyExtra: { category: 'Truck' },
    });

    await paginateWithCache({
      model,
      req: { query: {} },
      cachePrefix: 'allProducts',
      cacheKeyExtra: { category: 'Car' },
    });

    const keysWritten = mockRedis.set.mock.calls.map((call) => call[0]);
    expect(keysWritten).toHaveLength(2);
    expect(keysWritten[0]).not.toEqual(keysWritten[1]);
  });

  it('produces the same cache key for repeated calls with the same cacheKeyExtra', async () => {
    const model = buildModel([{ id: 'p1' }], 1);

    await paginateWithCache({
      model,
      req: { query: {} },
      cachePrefix: 'allProducts',
      cacheKeyExtra: { category: 'Truck', minPrice: '100' },
    });

    await paginateWithCache({
      model,
      req: { query: {} },
      cachePrefix: 'allProducts',
      cacheKeyExtra: { category: 'Truck', minPrice: '100' },
    });

    const keysWritten = mockRedis.set.mock.calls.map((call) => call[0]);
    expect(keysWritten[0]).toEqual(keysWritten[1]);
  });

  it('defaults cacheKeyExtra to {} so callers that omit it are unaffected', async () => {
    const model = buildModel([{ id: 'p1' }], 1);

    await expect(
      paginateWithCache({
        model,
        req: { query: {} },
        cachePrefix: 'banners',
      })
    ).resolves.toMatchObject({ data: [{ id: 'p1' }] });
  });

  it('serves from cache without hitting the model when a matching key exists', async () => {
    const cached = { data: [{ id: 'cached' }], meta: { total: 1 } };
    mockRedis.get.mockResolvedValue(JSON.stringify(cached));
    const model = buildModel();

    const result = await paginateWithCache({
      model,
      req: { query: {} },
      cachePrefix: 'allProducts',
      cacheKeyExtra: { category: 'Truck' },
    });

    expect(result).toEqual(cached);
    expect(model.findMany).not.toHaveBeenCalled();
  });

  // PHASE 12 — "prevent unbounded fetches". This is the one choke point
  // every paginated list (products, admin users, banners, new arrivals)
  // runs through, so capping it here protects all of them without each
  // caller having to remember to clamp its own `limit`.
  it('caps an oversized requested limit rather than passing it straight to the query', async () => {
    const model = buildModel([{ id: 'p1' }], 500);

    const result = await paginateWithCache({
      model,
      req: { query: { limit: '999999' } },
      cachePrefix: 'allProducts',
    });

    expect(model.findMany.mock.calls[0][0].take).toBe(100);
    expect(result.meta.limit).toBe(100);
  });

  it('falls back to the default limit for a non-positive or non-numeric limit', async () => {
    const model = buildModel([], 0);

    await paginateWithCache({ model, req: { query: { limit: '-5' } }, cachePrefix: 'x1' });
    expect(model.findMany.mock.calls[0][0].take).toBe(10);

    await paginateWithCache({ model, req: { query: { limit: 'not-a-number' } }, cachePrefix: 'x2' });
    expect(model.findMany.mock.calls[1][0].take).toBe(10);
  });

  it('falls back to page 1 for a non-positive or non-numeric page', async () => {
    const model = buildModel([], 0);

    await paginateWithCache({ model, req: { query: { page: '0' } }, cachePrefix: 'x3' });
    expect(model.findMany.mock.calls[0][0].skip).toBe(0);

    await paginateWithCache({ model, req: { query: { page: '-3' } }, cachePrefix: 'x4' });
    expect(model.findMany.mock.calls[1][0].skip).toBe(0);
  });
});
