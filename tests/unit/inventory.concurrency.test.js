// Concurrency tests for the atomic stock decrement at the heart of the
// checkout flow. Two (or more) shoppers can race to buy the last unit(s) of
// a product; only as many purchases as there is stock for should ever win.
//
// We double `@config/prisma` with an in-memory "database" whose
// `product.updateMany` mimics MongoDB's real guarantee: the read-check-write
// for a single document is one atomic operation. The check-and-mutate below
// is synchronous JS (no `await` in between), so no other concurrent caller
// can ever observe a half-applied state — exactly like a single Mongo
// document update. A small delay is added *after* the atomic mutation,
// before the promise resolves, to mimic real network/DB latency and force
// genuine interleaving between the concurrent callers in the test itself.

const productStore = {};

const resetProducts = (products) => {
  Object.keys(productStore).forEach((key) => delete productStore[key]);
  Object.assign(productStore, products);
};

const mockProduct = {
  updateMany: jest.fn(async ({ where, data }) => {
    const product = productStore[where.id];
    let count = 0;

    // --- Atomic section: synchronous, mirrors a single Mongo document
    // update — no interleaving is possible here no matter how many callers
    // are "in flight" at once.
    if (product && product.stock >= where.stock.gte) {
      product.stock -= data.stock.decrement;
      count = 1;
    }
    // --- End atomic section.

    // Simulate network/DB round-trip latency *after* the mutation has
    // already happened, so concurrent callers genuinely overlap in time.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));

    return { count };
  }),
  findUnique: jest.fn(async ({ where }) => productStore[where.id] || null),
};

jest.mock('@config/prisma', () => ({ product: mockProduct }));

const inventoryService = require('@modules/inventory/inventory.service');
const CustomError = require('@utils/customError');

beforeEach(() => {
  mockProduct.updateMany.mockClear();
  mockProduct.findUnique.mockClear();
});

describe('decrementStockForOrder — concurrent purchases of the last item', () => {
  it('only lets one of two simultaneous buyers take the last unit (throwOnInsufficientStock: false)', async () => {
    resetProducts({ prod_1: { id: 'prod_1', stock: 1 } });

    const buyerA = inventoryService.decrementStockForOrder(
      [{ productId: 'prod_1', quantity: 1 }],
      require('@config/prisma'),
      { throwOnInsufficientStock: false }
    );
    const buyerB = inventoryService.decrementStockForOrder(
      [{ productId: 'prod_1', quantity: 1 }],
      require('@config/prisma'),
      { throwOnInsufficientStock: false }
    );

    const [resultA, resultB] = await Promise.all([buyerA, buyerB]);

    // Exactly one buyer succeeds (empty "insufficient" list) and the other
    // is reported as unable to get stock — never both, never neither.
    const succeeded = [resultA, resultB].filter((r) => r.length === 0);
    const failed = [resultA, resultB].filter((r) => r.length === 1);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual([{ productId: 'prod_1', quantity: 1 }]);

    // Stock is fully consumed, never negative.
    expect(productStore.prod_1.stock).toBe(0);
  });

  it('lets the losing buyer\'s request throw a 409 instead of overselling (default throwOnInsufficientStock: true)', async () => {
    resetProducts({ prod_1: { id: 'prod_1', stock: 1 } });

    const results = await Promise.allSettled([
      inventoryService.decrementStockForOrder(
        [{ productId: 'prod_1', quantity: 1 }],
        require('@config/prisma')
      ),
      inventoryService.decrementStockForOrder(
        [{ productId: 'prod_1', quantity: 1 }],
        require('@config/prisma')
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CustomError);
    expect(rejected[0].reason.statusCode).toBe(409);
    expect(rejected[0].reason.message).toBe(
      'Insufficient stock for one or more items in this order'
    );

    // Stock is fully consumed by the one winner, never negative.
    expect(productStore.prod_1.stock).toBe(0);
  });

  it('never oversells when many buyers race for a handful of units', async () => {
    resetProducts({ prod_1: { id: 'prod_1', stock: 5 } });

    const buyers = Array.from({ length: 12 }, () =>
      inventoryService.decrementStockForOrder(
        [{ productId: 'prod_1', quantity: 1 }],
        require('@config/prisma'),
        { throwOnInsufficientStock: false }
      )
    );

    const results = await Promise.all(buyers);
    const succeeded = results.filter((r) => r.length === 0);
    const failed = results.filter((r) => r.length === 1);

    expect(succeeded).toHaveLength(5);
    expect(failed).toHaveLength(7);
    expect(productStore.prod_1.stock).toBe(0);
  });

  it('keeps each product independent when several last-of-kind items are bought at once', async () => {
    resetProducts({
      prod_1: { id: 'prod_1', stock: 1 },
      prod_2: { id: 'prod_2', stock: 1 },
    });

    // Same buyer's order needs the last unit of two different products —
    // races against another buyer wanting the same two products.
    const buyerA = inventoryService.decrementStockForOrder(
      [
        { productId: 'prod_1', quantity: 1 },
        { productId: 'prod_2', quantity: 1 },
      ],
      require('@config/prisma'),
      { throwOnInsufficientStock: false }
    );
    const buyerB = inventoryService.decrementStockForOrder(
      [
        { productId: 'prod_1', quantity: 1 },
        { productId: 'prod_2', quantity: 1 },
      ],
      require('@config/prisma'),
      { throwOnInsufficientStock: false }
    );

    const [resultA, resultB] = await Promise.all([buyerA, buyerB]);

    // Across both buyers, each product's single unit can only be claimed once.
    const allInsufficient = [...resultA, ...resultB];
    const prod1Failures = allInsufficient.filter(
      (i) => i.productId === 'prod_1'
    );
    const prod2Failures = allInsufficient.filter(
      (i) => i.productId === 'prod_2'
    );

    expect(prod1Failures).toHaveLength(1);
    expect(prod2Failures).toHaveLength(1);
    expect(productStore.prod_1.stock).toBe(0);
    expect(productStore.prod_2.stock).toBe(0);
  });
});
