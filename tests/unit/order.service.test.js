const mockCart = { findMany: jest.fn() };
const mockOrder = {
  findFirst: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};
const mockOrderItem = { deleteMany: jest.fn(), create: jest.fn() };
const mockAddress = { findUnique: jest.fn() };
const mockProduct = { findUnique: jest.fn() };
const mockShipment = { findMany: jest.fn(), findUnique: jest.fn() };
const mockPrisma = {
  cart: mockCart,
  order: mockOrder,
  orderItem: mockOrderItem,
  address: mockAddress,
  product: mockProduct,
  shipment: mockShipment,
  // Interactive-transaction style, matching cart.service / the rest of the
  // codebase.
  $transaction: jest.fn((cb) =>
    cb({
      cart: mockCart,
      order: mockOrder,
      orderItem: mockOrderItem,
      product: mockProduct,
    })
  ),
};
jest.mock('@config/prisma', () => mockPrisma);

// createDraftOrderService now takes a short-lived per-user Redis lock
// before its $transaction (see order.service.js) — mocked here so these
// tests never touch a real Redis connection. `set` resolves truthy by
// default (lock acquired) matching ioredis's `'OK'` on a successful
// `SET ... NX`; individual tests override it to simulate a lock miss.
const mockRedis = { set: jest.fn(), del: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

// detectAddressConflict now also checks delivery eligibility for the
// address's pincode — mocked here so these tests never reach the real
// shipping.service.js (and, through it, the Delhivery client / network).
jest.mock('@modules/shipping/shipping.service', () => ({
  checkDeliveryEligibility: jest.fn(),
}));

const shippingService = require('@modules/shipping/shipping.service');
const orderService = require('@modules/order/order.service');

const cartRow = (overrides = {}) => ({
  id: 'cart_1',
  userId: 'user_1',
  productId: 'prod_1',
  quantity: 2,
  // `...overrides` before `product` (not after): spreading overrides last
  // would let a caller-supplied `product` override wholesale replace the
  // merged object below instead of layering on top of it, silently
  // dropping fields (name/price/etc.) that override.product didn't set.
  ...overrides,
  product: {
    id: 'prod_1',
    name: 'Running Shoe',
    price: 1999,
    stock: 10,
    isDeleted: false,
    ...overrides.product,
  },
});

beforeEach(() => {
  mockCart.findMany.mockReset();
  mockOrder.findFirst.mockReset();
  mockOrder.update.mockReset();
  mockOrder.create.mockReset();
  mockOrder.findUnique.mockReset();
  mockOrder.findMany.mockReset();
  mockOrder.count.mockReset();
  mockOrderItem.deleteMany.mockReset();
  mockOrderItem.create.mockReset();
  mockAddress.findUnique.mockReset();
  mockProduct.findUnique.mockReset();
  mockShipment.findMany.mockReset();
  mockShipment.findUnique.mockReset();
  mockPrisma.$transaction.mockClear();
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.del.mockReset().mockResolvedValue(1);
});

describe('createDraftOrderService', () => {
  it('404s when the cart is empty', async () => {
    mockCart.findMany.mockResolvedValue([]);

    await expect(
      orderService.createDraftOrderService('user_1', null)
    ).rejects.toMatchObject({
      message: 'No items found in cart',
      statusCode: 404,
    });
  });

  it('409s without touching the cart/order tables when a concurrent checkout already holds the per-user lock', async () => {
    mockRedis.set.mockResolvedValue(null); // ioredis: SET ... NX returns null when the key already exists

    await expect(
      orderService.createDraftOrderService('user_1', null)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockCart.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('releases the per-user lock after a successful draft order creation', async () => {
    mockCart.findMany.mockResolvedValue([cartRow()]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', orderItems: [] });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'draft-order-lock:user_1',
      '1',
      'PX',
      expect.any(Number),
      'NX'
    );
    expect(mockRedis.del).toHaveBeenCalledWith('draft-order-lock:user_1');
  });

  it('releases the per-user lock even when the transaction throws', async () => {
    mockCart.findMany.mockResolvedValue([]); // triggers the empty-cart 404 inside the transaction

    await expect(
      orderService.createDraftOrderService('user_1', null)
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRedis.del).toHaveBeenCalledWith('draft-order-lock:user_1');
  });

  it('404s when the selected address does not belong to the user', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'someone_else',
    });

    await expect(
      orderService.createDraftOrderService('user_1', 'addr_1')
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockCart.findMany).not.toHaveBeenCalled();
  });

  it('409s (without touching order/orderItem tables) when every cart row points at a soft-deleted or missing product', async () => {
    mockCart.findMany.mockResolvedValue([
      cartRow({ product: { isDeleted: true } }),
      { ...cartRow({ productId: 'prod_ghost' }), product: null },
    ]);

    await expect(
      orderService.createDraftOrderService('user_1', null)
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mockOrder.create).not.toHaveBeenCalled();
    expect(mockOrder.update).not.toHaveBeenCalled();
  });

  it('409s with a structured insufficientStock payload when a cart quantity exceeds live stock', async () => {
    mockCart.findMany.mockResolvedValue([cartRow({ product: { stock: 1 } })]);

    await expect(
      orderService.createDraftOrderService('user_1', null)
    ).rejects.toMatchObject({
      statusCode: 409,
      errors: {
        insufficientStock: [
          {
            productId: 'prod_1',
            name: 'Running Shoe',
            requestedQuantity: 2,
            availableStock: 1,
          },
        ],
      },
    });
    expect(mockOrder.create).not.toHaveBeenCalled();
  });

  it('drops a soft-deleted line item but still proceeds with the rest of the cart', async () => {
    mockCart.findMany.mockResolvedValue([
      cartRow(), // prod_1, qty 2 @ 1999 = 3998
      cartRow({
        productId: 'prod_2',
        product: { id: 'prod_2', isDeleted: true },
      }),
    ]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 3998 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total: 3998 }),
      })
    );
    expect(mockOrderItem.create).toHaveBeenCalledTimes(1);
  });

  it('computes the order total from live product price, not any price cached on the cart row', async () => {
    // qty 2 @ 500 = 1000 subtotal — still clears the ₹600 free-delivery
    // threshold, so total stays equal to subtotal here (deliveryCharge 0).
    mockCart.findMany.mockResolvedValue([cartRow({ product: { price: 500 } })]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 1000 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          total: 1000,
          subtotal: 1000,
          deliveryCharge: 0,
        }),
      })
    );
    expect(mockOrderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ price: 500 }) })
    );
  });

  // See src/constants/pricing.js — ₹49 delivery charge below a ₹600
  // subtotal, free at or above it. This is what actually gets charged
  // (payment.controller.js reads `draftOrder.total`), so it has to be
  // right here, not just in the cart-page preview.
  it('adds the ₹49 delivery charge to the total when the subtotal is below ₹600', async () => {
    mockCart.findMany.mockResolvedValue([
      cartRow({ product: { price: 199 }, quantity: 2 }),
    ]); // 398 subtotal
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 447 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          total: 447,
          subtotal: 398,
          deliveryCharge: 49,
        }),
      })
    );
  });

  it('waives the delivery charge once the subtotal reaches exactly ₹600', async () => {
    mockCart.findMany.mockResolvedValue([
      cartRow({ product: { price: 600 }, quantity: 1 }),
    ]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 600 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          total: 600,
          subtotal: 600,
          deliveryCharge: 0,
        }),
      })
    );
  });

  it('replaces an existing draft order (clears old items, writes new ones) rather than creating a second draft', async () => {
    mockCart.findMany.mockResolvedValue([cartRow()]);
    mockOrder.findFirst.mockResolvedValue({ id: 'existing_draft' });
    mockOrderItem.deleteMany.mockResolvedValue({ count: 1 });
    mockOrder.update.mockResolvedValue({ id: 'existing_draft' });
    mockOrder.findUnique.mockResolvedValue({
      id: 'existing_draft',
      total: 3998,
    });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrderItem.deleteMany).toHaveBeenCalledWith({
      where: { orderId: 'existing_draft' },
    });
    expect(mockOrder.create).not.toHaveBeenCalled();
    expect(mockOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing_draft' } })
    );
  });

  // Discount/coupon placeholder architecture — see src/constants/pricing.js.
  // No Coupon model exists yet, so these pin the two behaviors that matter
  // today without hardcoding "always 0 forever" into the order flow itself.
  describe('couponCode', () => {
    it('defaults discount to 0 and leaves total unchanged when no coupon is given', async () => {
      mockCart.findMany.mockResolvedValue([cartRow()]); // qty 2 @ 1999 = 3998
      mockOrder.findFirst.mockResolvedValue(null);
      mockOrder.create.mockResolvedValue({ id: 'order_1' });
      mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 3998 });

      await orderService.createDraftOrderService('user_1', null);

      expect(mockOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            discount: 0,
            couponCode: null,
            total: 3998,
          }),
        })
      );
    });

    it('rejects an unrecognized coupon code and writes nothing (no coupons exist yet)', async () => {
      mockCart.findMany.mockResolvedValue([cartRow()]);

      await expect(
        orderService.createDraftOrderService('user_1', null, 'SAVE10')
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(mockOrder.create).not.toHaveBeenCalled();
      expect(mockOrder.update).not.toHaveBeenCalled();
    });
  });

  // Buy Now — see checkout-architecture.md §3.2 step 5 / §4.4. Must go
  // through the exact same server-side price/stock re-validation the cart
  // path gets above, not trust whatever the client claims the product/price
  // is, and must never touch the cart table.
  describe('buyNowItem', () => {
    const buyNowProduct = (overrides = {}) => ({
      id: 'prod_9',
      name: 'Wireless Mouse',
      price: 999,
      stock: 5,
      isDeleted: false,
      ...overrides,
    });

    it('builds the draft order from the product instead of reading the cart', async () => {
      mockProduct.findUnique.mockResolvedValue(buyNowProduct());
      mockOrder.findFirst.mockResolvedValue(null);
      mockOrder.create.mockResolvedValue({ id: 'order_1' });
      mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 999 });

      await orderService.createDraftOrderService('user_1', null, null, {
        productId: 'prod_9',
        quantity: 1,
      });

      expect(mockCart.findMany).not.toHaveBeenCalled();
      expect(mockProduct.findUnique).toHaveBeenCalledWith({
        where: { id: 'prod_9' },
      });
      expect(mockOrderItem.create).toHaveBeenCalledTimes(1);
      expect(mockOrderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: 'prod_9',
            quantity: 1,
            price: 999,
          }),
        })
      );
      expect(mockOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ total: 999, subtotal: 999 }),
        })
      );
    });

    it('409s when the buy-now product no longer exists', async () => {
      mockProduct.findUnique.mockResolvedValue(null);

      await expect(
        orderService.createDraftOrderService('user_1', null, null, {
          productId: 'prod_ghost',
          quantity: 1,
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(mockOrder.create).not.toHaveBeenCalled();
    });

    it('409s when the buy-now product has been soft-deleted', async () => {
      mockProduct.findUnique.mockResolvedValue(
        buyNowProduct({ isDeleted: true })
      );

      await expect(
        orderService.createDraftOrderService('user_1', null, null, {
          productId: 'prod_9',
          quantity: 1,
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(mockOrder.create).not.toHaveBeenCalled();
    });

    it('409s with a structured insufficientStock payload when the requested quantity exceeds live stock', async () => {
      mockProduct.findUnique.mockResolvedValue(buyNowProduct({ stock: 1 }));

      await expect(
        orderService.createDraftOrderService('user_1', null, null, {
          productId: 'prod_9',
          quantity: 3,
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        errors: {
          insufficientStock: [
            {
              productId: 'prod_9',
              name: 'Wireless Mouse',
              requestedQuantity: 3,
              availableStock: 1,
            },
          ],
        },
      });
      expect(mockOrder.create).not.toHaveBeenCalled();
    });

    it('prices from the live product record, ignoring any price the caller might claim', async () => {
      mockProduct.findUnique.mockResolvedValue(buyNowProduct({ price: 2500 }));
      mockOrder.findFirst.mockResolvedValue(null);
      mockOrder.create.mockResolvedValue({ id: 'order_1' });
      mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 2500 });

      await orderService.createDraftOrderService('user_1', null, null, {
        productId: 'prod_9',
        // A client can only ever send productId/quantity — there is no price
        // field on buyNowItem in the first place, so this is asserting the
        // absence of one rather than a value being overridden.
        quantity: 1,
      });

      expect(mockOrderItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ price: 2500 }),
        })
      );
    });
  });
});

// Price/stock conflict detection — this is the guard that runs right
// before anything irreversible happens (COD placement, Razorpay order
// creation — see payment.service.js / payment.controller.js), comparing an
// already-priced OrderItem snapshot against live Product data.
describe('detectOrderConflicts', () => {
  beforeEach(() => {
    mockProduct.findUnique.mockReset();
  });

  const orderedItem = (overrides = {}) => ({
    productId: 'prod_1',
    quantity: 2,
    price: 999,
    ...overrides,
  });

  it('returns no conflicts when price and stock still match live product data', async () => {
    mockProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      name: 'Running Shoe',
      price: 999,
      stock: 5,
      isDeleted: false,
    });

    const conflicts = await orderService.detectOrderConflicts([orderedItem()]);

    expect(conflicts).toEqual([]);
  });

  it('flags a price_changed conflict when the live price no longer matches the snapshotted price', async () => {
    mockProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      name: 'Running Shoe',
      price: 1199,
      stock: 5,
      isDeleted: false,
    });

    const conflicts = await orderService.detectOrderConflicts([
      orderedItem({ price: 999 }),
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({
        productId: 'prod_1',
        type: 'price_changed',
        orderedPrice: 999,
        currentPrice: 1199,
      }),
    ]);
  });

  it('flags an insufficient_stock conflict when the ordered quantity exceeds live stock', async () => {
    mockProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      name: 'Running Shoe',
      price: 999,
      stock: 1,
      isDeleted: false,
    });

    const conflicts = await orderService.detectOrderConflicts([
      orderedItem({ quantity: 2 }),
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({
        productId: 'prod_1',
        type: 'insufficient_stock',
        requestedQuantity: 2,
        availableStock: 1,
      }),
    ]);
  });

  it('can flag both a price change and a stock shortfall on the same item', async () => {
    mockProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      name: 'Running Shoe',
      price: 1199,
      stock: 1,
      isDeleted: false,
    });

    const conflicts = await orderService.detectOrderConflicts([
      orderedItem({ price: 999, quantity: 2 }),
    ]);

    expect(conflicts).toHaveLength(2);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'price_changed' }),
        expect.objectContaining({ type: 'insufficient_stock' }),
      ])
    );
  });

  it('flags an unavailable conflict (and skips the price/stock checks) when the product is missing', async () => {
    mockProduct.findUnique.mockResolvedValue(null);

    const conflicts = await orderService.detectOrderConflicts([orderedItem()]);

    expect(conflicts).toEqual([
      expect.objectContaining({ productId: 'prod_1', type: 'unavailable' }),
    ]);
  });

  it('flags an unavailable conflict when the product has since been soft-deleted', async () => {
    mockProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      name: 'Running Shoe',
      price: 999,
      stock: 5,
      isDeleted: true,
    });

    const conflicts = await orderService.detectOrderConflicts([orderedItem()]);

    expect(conflicts).toEqual([
      expect.objectContaining({ productId: 'prod_1', type: 'unavailable' }),
    ]);
  });

  it('checks every line item independently and only reports the ones that actually conflict', async () => {
    mockProduct.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'prod_1') {
        return {
          id: 'prod_1',
          name: 'Running Shoe',
          price: 999,
          stock: 5,
          isDeleted: false,
        };
      }
      if (where.id === 'prod_2') {
        return {
          id: 'prod_2',
          name: 'Cap',
          price: 599,
          stock: 5,
          isDeleted: false,
        }; // was 499 -> drifted
      }
      return null;
    });

    const conflicts = await orderService.detectOrderConflicts([
      orderedItem({ productId: 'prod_1', price: 999 }),
      orderedItem({ productId: 'prod_2', price: 499 }),
    ]);

    expect(conflicts).toEqual([
      expect.objectContaining({ productId: 'prod_2', type: 'price_changed' }),
    ]);
  });

  it('reads through the provided transaction client rather than the top-level prisma client when one is passed', async () => {
    const txProduct = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'prod_1',
        name: 'Running Shoe',
        price: 999,
        stock: 5,
        isDeleted: false,
      }),
    };
    const tx = { product: txProduct };

    await orderService.detectOrderConflicts([orderedItem()], tx);

    expect(txProduct.findUnique).toHaveBeenCalledWith({
      where: { id: 'prod_1' },
    });
    expect(mockProduct.findUnique).not.toHaveBeenCalled();
  });
});

describe('detectAddressConflict', () => {
  beforeEach(() => {
    mockAddress.findUnique.mockReset();
    shippingService.checkDeliveryEligibility.mockReset();
    // Default: address's pincode is deliverable and COD-eligible, so tests
    // that aren't specifically about delivery eligibility don't need to
    // set this up themselves.
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: true,
      reason: null,
      codAvailable: true,
      skippedCheck: false,
    });
  });

  it('returns no conflicts when the address still exists, belongs to the user, and is deliverable', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([]);
    expect(shippingService.checkDeliveryEligibility).toHaveBeenCalledWith({
      destinationPincode: '400001',
      paymentMode: 'PREPAID',
    });
  });

  it('flags an address_unavailable conflict when the address has been deleted', async () => {
    mockAddress.findUnique.mockResolvedValue(null);

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'address_unavailable' }),
    ]);
    // Nothing to check delivery for once the address itself is gone.
    expect(shippingService.checkDeliveryEligibility).not.toHaveBeenCalled();
  });

  it('flags an address_unavailable conflict when the address now belongs to a different user', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'someone_else',
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'address_unavailable' }),
    ]);
  });

  it('flags an address_unavailable conflict without querying when no addressId is given', async () => {
    const conflicts = await orderService.detectAddressConflict(null, 'user_1');

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'address_unavailable' }),
    ]);
    expect(mockAddress.findUnique).not.toHaveBeenCalled();
  });

  it('reads through the provided transaction client rather than the top-level prisma client when one is passed', async () => {
    const txAddress = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'addr_1',
        userId: 'user_1',
        pincode: '400001',
      }),
    };
    const tx = { address: txAddress };

    await orderService.detectAddressConflict('addr_1', 'user_1', tx);

    expect(txAddress.findUnique).toHaveBeenCalledWith({
      where: { id: 'addr_1' },
    });
    expect(mockAddress.findUnique).not.toHaveBeenCalled();
  });

  it('flags a delivery_unavailable conflict when the pincode is a real one Delhivery just does not cover', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: false,
      reason: 'AREA_NOT_COVERED',
      codAvailable: false,
      skippedCheck: false,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'delivery_unavailable' }),
    ]);
  });

  it('flags an invalid_pincode conflict when Delhivery does not recognize the pincode at all', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '999999',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: false,
      reason: 'INVALID_PINCODE',
      codAvailable: false,
      skippedCheck: false,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'invalid_pincode' }),
    ]);
  });

  it('flags an invalid_pincode conflict (and blocks placement) for a malformed/unrecognizable stored pincode', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: false,
      reason: 'INVALID_FORMAT',
      codAvailable: false,
      skippedCheck: false,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'invalid_pincode' }),
    ]);
  });

  it('flags a cod_unavailable conflict when a COD order is placed against a prepaid-only pincode', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: true,
      reason: null,
      codAvailable: false,
      skippedCheck: false,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1',
      undefined,
      'COD'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'cod_unavailable' }),
    ]);
    expect(shippingService.checkDeliveryEligibility).toHaveBeenCalledWith({
      destinationPincode: '400001',
      paymentMode: 'COD',
    });
  });

  it('does not flag cod_unavailable for a prepaid order even when the pincode has no COD coverage', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: true,
      reason: null,
      codAvailable: false,
      skippedCheck: false,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([]);
  });

  it('does not block the order when the eligibility check itself failed under the fail-open policy', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: true,
      reason: null,
      codAvailable: true,
      skippedCheck: true,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1',
      undefined,
      'COD'
    );

    expect(conflicts).toEqual([]);
  });

  it('flags a delivery_check_unavailable conflict (and blocks placement) when the eligibility check failed under a fail-closed policy', async () => {
    mockAddress.findUnique.mockResolvedValue({
      id: 'addr_1',
      userId: 'user_1',
      pincode: '400001',
    });
    // Shape checkDeliveryEligibility returns under
    // SHIPPING_SERVICEABILITY_FALLBACK_POLICY=fail_closed (see
    // shipping.service.js) — a distinct reason from AREA_NOT_COVERED, since
    // this is "we couldn't check" rather than "we checked and it's a no".
    shippingService.checkDeliveryEligibility.mockResolvedValue({
      serviceable: false,
      reason: 'CHECK_UNAVAILABLE',
      codAvailable: false,
      skippedCheck: true,
    });

    const conflicts = await orderService.detectAddressConflict(
      'addr_1',
      'user_1'
    );

    expect(conflicts).toEqual([
      expect.objectContaining({ type: 'delivery_check_unavailable' }),
    ]);
    // Distinct wording from a real "not covered" answer — never tells the
    // customer to pick a different address for what's actually a carrier
    // outage.
    expect(conflicts[0].message).toMatch(/try again/i);
  });
});

// Delivery-charge/total drift — the guard that catches an env-level
// pricing config change (FREE_DELIVERY_THRESHOLD/DELIVERY_CHARGE — see
// src/constants/pricing.js) made after a draft order was created, which
// detectOrderConflicts alone (item price/stock only) would never catch.
// Test env: ₹49 delivery charge below a ₹600 subtotal, free at/above it —
// same figures the createDraftOrderService tests above use.
describe('detectPricingConflict', () => {
  it('returns no conflicts when the stored delivery charge/total still match the current rule', () => {
    const order = {
      subtotal: 398,
      discount: 0,
      deliveryCharge: 49,
      total: 447,
    };

    expect(orderService.detectPricingConflict(order)).toEqual([]);
  });

  it('returns no conflicts for a free-delivery order at/above the threshold', () => {
    const order = { subtotal: 600, discount: 0, deliveryCharge: 0, total: 600 };

    expect(orderService.detectPricingConflict(order)).toEqual([]);
  });

  it('flags a pricing_changed conflict when the stored delivery charge no longer matches the current rule', () => {
    // Stored as if delivery had been free (e.g. computed under a since-
    // lowered threshold, or before DELIVERY_CHARGE was raised) — the
    // current rule (₹49 below ₹600) now disagrees.
    const order = { subtotal: 398, discount: 0, deliveryCharge: 0, total: 398 };

    const conflicts = orderService.detectPricingConflict(order);

    expect(conflicts).toEqual([
      expect.objectContaining({
        type: 'pricing_changed',
        previousTotal: 398,
        currentTotal: 447,
      }),
    ]);
  });

  it('flags a pricing_changed conflict when the stored total no longer matches subtotal + current delivery charge - discount', () => {
    const order = {
      subtotal: 600,
      discount: 0,
      deliveryCharge: 49,
      total: 649,
    };

    const conflicts = orderService.detectPricingConflict(order);

    expect(conflicts).toEqual([
      expect.objectContaining({
        type: 'pricing_changed',
        previousTotal: 649,
        currentTotal: 600,
      }),
    ]);
  });
});

describe('getUserOrderHistory', () => {
  it('excludes draft orders and scopes to the given user', async () => {
    mockOrder.count.mockResolvedValue(2);
    mockOrder.findMany.mockResolvedValue([
      { id: 'order_1', status: 'confirmed', total: 500 },
      { id: 'order_2', status: 'delivered', total: 900 },
    ]);

    const result = await orderService.getUserOrderHistory('user_1', {});

    expect(mockOrder.count).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: { not: 'draft' } },
    });
    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1', status: { not: 'draft' } },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 10,
      })
    );
    expect(result.orders).toHaveLength(2);
    expect(result.meta).toEqual({
      total: 2,
      page: 1,
      limit: 10,
      totalPages: 1,
    });
  });

  it('applies page/limit to compute the correct skip and meta', async () => {
    mockOrder.count.mockResolvedValue(23);
    mockOrder.findMany.mockResolvedValue([]);

    const result = await orderService.getUserOrderHistory('user_1', {
      page: 3,
      limit: 5,
    });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
    expect(result.meta).toEqual({
      total: 23,
      page: 3,
      limit: 5,
      totalPages: 5,
    });
  });

  it('clamps a non-positive page and an out-of-range limit to safe defaults', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);

    const result = await orderService.getUserOrderHistory('user_1', {
      page: -5,
      limit: 500,
    });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 50 })
    );
    expect(result.meta).toEqual({
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
  });

  it('returns an empty page (not an error) when the user has no placed orders', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);

    const result = await orderService.getUserOrderHistory('user_1', {});

    expect(result.orders).toEqual([]);
    expect(result.meta.totalPages).toBe(0);
  });
});

describe('getAllOrders', () => {
  const orderRow = (overrides = {}) => ({
    id: 'order_1',
    userId: 'user_1',
    user: { id: 'user_1', name: 'Jane Doe', email: 'jane@example.com' },
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    total: 1500,
    subtotal: 1400,
    deliveryCharge: 100,
    discount: 0,
    couponCode: null,
    status: 'confirmed',
    paymentStatus: 'paid',
    ...overrides,
  });

  it('always excludes draft orders from the base query', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({});

    expect(mockOrder.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'draft' } }),
      })
    );
    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'draft' } }),
      })
    );
  });

  it('applies default page/limit and returns matching meta', async () => {
    mockOrder.count.mockResolvedValue(1);
    mockOrder.findMany.mockResolvedValue([orderRow()]);
    mockShipment.findMany.mockResolvedValue([]);

    const result = await orderService.getAllOrders({});

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 })
    );
    expect(result.orders).toHaveLength(1);
    expect(result.meta).toEqual({
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });
  });

  it('clamps a non-positive page and an out-of-range limit to safe defaults', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    const result = await orderService.getAllOrders({ page: -5, limit: 5000 });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 })
    );
    expect(result.meta).toEqual({
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
  });

  it('filters by a valid order status', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({ status: 'shipped' });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'shipped' }),
      })
    );
  });

  it('ignores an out-of-enum status rather than passing it through to prisma', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({ status: 'draft' });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'draft' } }),
      })
    );
  });

  it('filters by paymentStatus independently of order status', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({ paymentStatus: 'paid' });

    expect(mockOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentStatus: 'paid' }),
      })
    );
  });

  it('builds an inclusive createdAt range from dateFrom/dateTo', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    });

    const call = mockOrder.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toEqual(new Date('2026-01-01'));
    expect(call.where.createdAt.lte.getHours()).toBe(23);
    expect(call.where.createdAt.lte.getMinutes()).toBe(59);
  });

  it('searches by customer name/email and, when id-shaped, exact order id', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({ search: 'jane' });

    const call = mockOrder.findMany.mock.calls[0][0];
    const orCondition = call.where.AND[0].OR;
    expect(orCondition).toEqual(
      expect.arrayContaining([
        { user: { name: { contains: 'jane', mode: 'insensitive' } } },
        { user: { email: { contains: 'jane', mode: 'insensitive' } } },
      ])
    );
    // Not id-shaped, so no id condition should be present.
    expect(orCondition.some((c) => 'id' in c)).toBe(false);
  });

  it('adds an exact order-id match when the search term is a 24-char hex id', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);
    mockShipment.findMany.mockResolvedValue([]);

    const objectId = '507f1f77bcf86cd799439099';
    await orderService.getAllOrders({ search: objectId });

    const call = mockOrder.findMany.mock.calls[0][0];
    const orCondition = call.where.AND[0].OR;
    expect(orCondition).toEqual(expect.arrayContaining([{ id: objectId }]));
  });

  it('attaches shipmentStatus/trackingId from a batched shipment lookup, keyed by orderId', async () => {
    mockOrder.count.mockResolvedValue(2);
    mockOrder.findMany.mockResolvedValue([
      orderRow({ id: 'order_1' }),
      orderRow({
        id: 'order_2',
        status: 'pending',
        paymentStatus: 'cod_pending',
      }),
    ]);
    mockShipment.findMany.mockResolvedValue([
      { orderId: 'order_1', status: 'IN_TRANSIT', trackingId: 'AWB123' },
    ]);

    const result = await orderService.getAllOrders({});

    expect(mockShipment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: { in: ['order_1', 'order_2'] } },
      })
    );
    expect(result.orders.find((o) => o.id === 'order_1')).toMatchObject({
      shipmentStatus: 'IN_TRANSIT',
      trackingId: 'AWB123',
    });
    // No shipment yet (e.g. not shipped) -> null, not undefined/omitted,
    // and NEVER inferred from order/payment status.
    expect(result.orders.find((o) => o.id === 'order_2')).toMatchObject({
      shipmentStatus: null,
      trackingId: null,
    });
  });

  it('never queries shipments when there are no orders on the page', async () => {
    mockOrder.count.mockResolvedValue(0);
    mockOrder.findMany.mockResolvedValue([]);

    await orderService.getAllOrders({});

    expect(mockShipment.findMany).not.toHaveBeenCalled();
  });

  it('keeps status and paymentStatus as separate fields on every returned order', async () => {
    mockOrder.count.mockResolvedValue(1);
    mockOrder.findMany.mockResolvedValue([
      orderRow({ status: 'pending', paymentStatus: 'failed' }),
    ]);
    mockShipment.findMany.mockResolvedValue([]);

    const result = await orderService.getAllOrders({});

    expect(result.orders[0].status).toBe('pending');
    expect(result.orders[0].paymentStatus).toBe('failed');
  });
});

describe('fetchOrderById', () => {
  const baseOrder = (overrides = {}) => ({
    id: 'order_1',
    userId: 'user_1',
    total: 1999,
    subtotal: 1899,
    deliveryCharge: 100,
    discount: 0,
    couponCode: null,
    status: 'confirmed',
    paymentStatus: 'paid',
    payment_order_id: 'order_rzp_1',
    payment_id: 'pay_rzp_1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T01:00:00.000Z'),
    user: {
      id: 'user_1',
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '9999999999',
    },
    address: {
      id: 'addr_1',
      name: 'Jane Doe',
      phone: '9999999999',
      city: 'Pune',
    },
    orderItems: [
      {
        id: 'item_1',
        quantity: 2,
        price: 999,
        product: { name: 'Running Shoe' },
      },
    ],
    ...overrides,
  });

  it('returns null when the order does not exist, without querying shipment', async () => {
    mockOrder.findUnique.mockResolvedValue(null);

    const result = await orderService.fetchOrderById('missing_id');

    expect(result).toBeNull();
    expect(mockShipment.findUnique).not.toHaveBeenCalled();
  });

  it('requests full customer identity (id, name, email, phone), not just name', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder());
    mockShipment.findUnique.mockResolvedValue(null);

    await orderService.fetchOrderById('order_1');

    expect(mockOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1' },
        include: expect.objectContaining({
          user: expect.objectContaining({
            select: { id: true, name: true, email: true, phone: true },
          }),
        }),
      })
    );
  });

  it('attaches shipment: null when no shipment has been created yet', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder());
    mockShipment.findUnique.mockResolvedValue(null);

    const result = await orderService.fetchOrderById('order_1');

    expect(result.shipment).toBeNull();
  });

  it('attaches the persisted shipment (minus the internal raw payload) when one exists', async () => {
    mockOrder.findUnique.mockResolvedValue(baseOrder({ status: 'shipped' }));
    mockShipment.findUnique.mockResolvedValue({
      id: 'ship_1',
      trackingId: 'AWB123',
      awbNumber: 'AWB123',
      courierPartner: 'Delhivery',
      status: 'IN_TRANSIT',
      paymentMode: 'PREPAID',
      codAmount: 0,
      lastLocation: 'Pune Hub',
      estimatedDeliveryDate: new Date('2026-01-05T00:00:00.000Z'),
      lastSyncedAt: new Date('2026-01-02T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T02:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await orderService.fetchOrderById('order_1');

    expect(result.shipment).toMatchObject({
      status: 'IN_TRANSIT',
      trackingId: 'AWB123',
    });
    expect(result.shipment.raw).toBeUndefined();
    // Never fetched with a bare `include: true` — raw must be excluded at
    // the query level, not stripped after the fact, so it's never even
    // pulled out of Mongo for this endpoint.
    expect(mockShipment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order_1' },
        select: expect.not.objectContaining({ raw: true }),
      })
    );
  });

  it('never derives shipment fields from order.status — always reads the persisted Shipment row as-is', async () => {
    // Order says 'shipped', but the Shipment row (source of truth) says
    // CANCELLED — e.g. cancelled after creation. The response must reflect
    // the real shipment status, not something inferred from order.status.
    mockOrder.findUnique.mockResolvedValue(baseOrder({ status: 'shipped' }));
    mockShipment.findUnique.mockResolvedValue({
      id: 'ship_1',
      status: 'CANCELLED',
    });

    const result = await orderService.fetchOrderById('order_1');

    expect(result.status).toBe('shipped');
    expect(result.shipment.status).toBe('CANCELLED');
  });

  it('preserves existing order/address/orderItems fields unchanged (additive only)', async () => {
    const order = baseOrder();
    mockOrder.findUnique.mockResolvedValue(order);
    mockShipment.findUnique.mockResolvedValue(null);

    const result = await orderService.fetchOrderById('order_1');

    expect(result.address).toEqual(order.address);
    expect(result.orderItems).toEqual(order.orderItems);
    expect(result.total).toBe(order.total);
    expect(result.payment_id).toBe(order.payment_id);
    expect(result.payment_order_id).toBe(order.payment_order_id);
  });
});
