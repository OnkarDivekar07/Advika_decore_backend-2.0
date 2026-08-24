// Unit tests for inventory.service.adjustStock — the admin manual
// stock-correction path. Focuses on what the integration test (which mocks
// the whole service) can't see: the actual set/increment/decrement logic,
// and the optimistic-concurrency precondition used to protect 'set' against
// stale-read overwrites when two admins act on the same product at once.

const productStore = {};

const resetProducts = (products) => {
  Object.keys(productStore).forEach((key) => delete productStore[key]);
  Object.assign(productStore, products);
};

const clone = (p) => (p ? { ...p } : null);

const mockProduct = {
  findUnique: jest.fn(async ({ where, select }) => {
    const product = productStore[where.id];
    if (!product) return null;
    if (!select) return clone(product);
    const picked = {};
    Object.keys(select).forEach((key) => {
      if (select[key]) picked[key] = product[key];
    });
    return picked;
  }),
  update: jest.fn(async ({ where, data }) => {
    const product = productStore[where.id];
    if (!product) throw new Error('not found');
    if (data.stock && typeof data.stock === 'object') {
      if (data.stock.increment !== undefined)
        product.stock += data.stock.increment;
      if (data.stock.decrement !== undefined)
        product.stock -= data.stock.decrement;
    } else {
      product.stock = data.stock;
    }
    return clone(product);
  }),
  updateMany: jest.fn(async ({ where, data }) => {
    const product = productStore[where.id];
    let count = 0;

    const matchesStock =
      where.stock === undefined ||
      (typeof where.stock === 'object' && where.stock.gte !== undefined
        ? product && product.stock >= where.stock.gte
        : product && product.stock === where.stock);

    if (product && matchesStock) {
      if (
        data.stock &&
        typeof data.stock === 'object' &&
        data.stock.decrement !== undefined
      ) {
        product.stock -= data.stock.decrement;
      } else {
        product.stock = data.stock;
      }
      count = 1;
    }

    return { count };
  }),
};

jest.mock('@config/prisma', () => ({ product: mockProduct }));

const inventoryService = require('@modules/inventory/inventory.service');
const CustomError = require('@utils/customError');

beforeEach(() => {
  mockProduct.findUnique.mockClear();
  mockProduct.update.mockClear();
  mockProduct.updateMany.mockClear();
});

describe('inventoryService.adjustStock', () => {
  it('throws 404 when the product does not exist', async () => {
    resetProducts({});

    await expect(
      inventoryService.adjustStock('missing', 'set', 5)
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Product not found',
    });
  });

  describe("action: 'set'", () => {
    it('blindly overwrites stock when no expectedStock is given (previous behavior)', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      const result = await inventoryService.adjustStock('prod_1', 'set', 20);

      expect(result.stock).toBe(20);
      expect(productStore.prod_1.stock).toBe(20);
    });

    it('applies the set when expectedStock matches current stock', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      const result = await inventoryService.adjustStock('prod_1', 'set', 20, 8);

      expect(result.stock).toBe(20);
    });

    it('rejects with 409 and the current stock when expectedStock is stale', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      await expect(
        inventoryService.adjustStock('prod_1', 'set', 20, 5)
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: { currentStock: 8 },
      });

      // Stock is untouched — the stale write never applied.
      expect(productStore.prod_1.stock).toBe(8);
    });

    it('rejects with a CustomError instance on a stale expectedStock', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      await expect(
        inventoryService.adjustStock('prod_1', 'set', 20, 5)
      ).rejects.toBeInstanceOf(CustomError);
    });
  });

  describe("action: 'increment'", () => {
    it('adds to the current stock', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      const result = await inventoryService.adjustStock(
        'prod_1',
        'increment',
        12
      );

      expect(result.stock).toBe(20);
    });
  });

  describe("action: 'decrement'", () => {
    it('subtracts from the current stock when enough is available', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

      const result = await inventoryService.adjustStock(
        'prod_1',
        'decrement',
        5
      );

      expect(result.stock).toBe(3);
    });

    it('throws 409 without mutating stock when the decrement exceeds availability', async () => {
      resetProducts({ prod_1: { id: 'prod_1', stock: 3 } });

      await expect(
        inventoryService.adjustStock('prod_1', 'decrement', 10)
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(productStore.prod_1.stock).toBe(3);
    });
  });

  it('throws 400 for an unrecognized action', async () => {
    resetProducts({ prod_1: { id: 'prod_1', stock: 8 } });

    await expect(
      inventoryService.adjustStock('prod_1', 'nuke', 1)
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
