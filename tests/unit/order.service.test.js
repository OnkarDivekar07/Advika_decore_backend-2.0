const mockCart = { findMany: jest.fn() };
const mockOrder = {
  findFirst: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
  findUnique: jest.fn(),
};
const mockOrderItem = { deleteMany: jest.fn(), create: jest.fn() };
const mockAddress = { findUnique: jest.fn() };
const mockPrisma = {
  cart: mockCart,
  order: mockOrder,
  orderItem: mockOrderItem,
  address: mockAddress,
  // Interactive-transaction style, matching cart.service / the rest of the
  // codebase.
  $transaction: jest.fn((cb) =>
    cb({ cart: mockCart, order: mockOrder, orderItem: mockOrderItem })
  ),
};
jest.mock('@config/prisma', () => mockPrisma);

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
  mockOrderItem.deleteMany.mockReset();
  mockOrderItem.create.mockReset();
  mockAddress.findUnique.mockReset();
  mockPrisma.$transaction.mockClear();
});

describe('createDraftOrderService', () => {
  it('404s when the cart is empty', async () => {
    mockCart.findMany.mockResolvedValue([]);

    await expect(orderService.createDraftOrderService('user_1', null)).rejects.toMatchObject({
      message: 'No items found in cart',
      statusCode: 404,
    });
  });

  it('404s when the selected address does not belong to the user', async () => {
    mockAddress.findUnique.mockResolvedValue({ id: 'addr_1', userId: 'someone_else' });

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

    await expect(orderService.createDraftOrderService('user_1', null)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mockOrder.create).not.toHaveBeenCalled();
    expect(mockOrder.update).not.toHaveBeenCalled();
  });

  it('409s with a structured insufficientStock payload when a cart quantity exceeds live stock', async () => {
    mockCart.findMany.mockResolvedValue([cartRow({ product: { stock: 1 } })]);

    await expect(orderService.createDraftOrderService('user_1', null)).rejects.toMatchObject({
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
      cartRow({ productId: 'prod_2', product: { id: 'prod_2', isDeleted: true } }),
    ]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 3998 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ total: 3998 }) })
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
        data: expect.objectContaining({ total: 1000, subtotal: 1000, deliveryCharge: 0 }),
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
    mockCart.findMany.mockResolvedValue([cartRow({ product: { price: 199 }, quantity: 2 })]); // 398 subtotal
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 447 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total: 447, subtotal: 398, deliveryCharge: 49 }),
      })
    );
  });

  it('waives the delivery charge once the subtotal reaches exactly ₹600', async () => {
    mockCart.findMany.mockResolvedValue([cartRow({ product: { price: 600 }, quantity: 1 })]);
    mockOrder.findFirst.mockResolvedValue(null);
    mockOrder.create.mockResolvedValue({ id: 'order_1' });
    mockOrder.findUnique.mockResolvedValue({ id: 'order_1', total: 600 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total: 600, subtotal: 600, deliveryCharge: 0 }),
      })
    );
  });

  it('replaces an existing draft order (clears old items, writes new ones) rather than creating a second draft', async () => {
    mockCart.findMany.mockResolvedValue([cartRow()]);
    mockOrder.findFirst.mockResolvedValue({ id: 'existing_draft' });
    mockOrderItem.deleteMany.mockResolvedValue({ count: 1 });
    mockOrder.update.mockResolvedValue({ id: 'existing_draft' });
    mockOrder.findUnique.mockResolvedValue({ id: 'existing_draft', total: 3998 });

    await orderService.createDraftOrderService('user_1', null);

    expect(mockOrderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'existing_draft' } });
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
          data: expect.objectContaining({ discount: 0, couponCode: null, total: 3998 }),
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
});
