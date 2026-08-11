const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');
const { calculateDeliveryCharge, calculateDiscount } = require('@constants/pricing');


/**
 * Compares a set of already-priced order items (an OrderItem snapshot — see
 * createDraftOrderService below, which locks in `price` at draft-order time)
 * against live Product data, to catch a draft order that's gone stale
 * between when its price/stock was snapshotted and now. A draft order can
 * sit unpaid for a while (customer steps away mid-checkout, slow Razorpay
 * modal, etc.), and in that window a product's price can change or its
 * stock can be eaten by other orders — this is what surfaces that drift as
 * a clear, structured conflict instead of either silently charging an
 * outdated price or falling all the way through to the atomic stock
 * decrement's generic "insufficient stock" error with no mention of price.
 *
 * Callers are expected to run this — and refuse to proceed on any conflict —
 * at every point that's still safe to refuse: before placing a COD order,
 * and before creating the Razorpay order that will actually be charged (see
 * payment.service.js / payment.controller.js). It is deliberately NOT
 * called once money has actually moved (payment /verify or the webhook):
 * per the payment-service reconciliation invariant, a captured payment is
 * never un-confirmed over a price/stock drift discovered after the fact —
 * that's logged as an oversell instead and handled manually.
 *
 * @param {Array<{ productId: string, quantity: number, price: number }>} orderItems
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} [client] - defaults to the top-level prisma client; pass a transaction client to read consistently with other writes in the same transaction
 * @returns {Promise<Array<object>>} conflicts — empty array if the order still matches live product data
 */
exports.detectOrderConflicts = async (orderItems, client = prisma) => {
  const conflicts = [];

  for (const item of orderItems) {
    const product = await client.product.findUnique({ where: { id: item.productId } });

    if (!product || product.isDeleted) {
      conflicts.push({
        productId: item.productId,
        type: 'unavailable',
        message: 'This item is no longer available.',
      });
      continue;
    }

    // Strict inequality on purpose — Product.price is the single live
    // source of truth (src/constants/pricing.js's whole premise), so any
    // drift at all from what was snapshotted onto the OrderItem is a
    // conflict, not just a "significant" one. A real coupon/promo system
    // changing prices frequently would still want the customer to see and
    // accept the new price before being charged it.
    if (product.price !== item.price) {
      conflicts.push({
        productId: item.productId,
        name: product.name,
        type: 'price_changed',
        orderedPrice: item.price,
        currentPrice: product.price,
        message: 'The price of this item has changed since it was added to your order.',
      });
    }

    if (item.quantity > product.stock) {
      conflicts.push({
        productId: item.productId,
        name: product.name,
        type: 'insufficient_stock',
        requestedQuantity: item.quantity,
        availableStock: product.stock,
        message: 'The requested quantity is no longer available.',
      });
    }
  }

  return conflicts;
};


/**
 * Companion check to detectOrderConflicts above, but for the address side
 * of a draft order rather than its line items. A draft order can sit
 * around for a while before it's paid for, and in that window the address
 * it points at can be deleted — from another tab, another device, this
 * same tab's own "Remove" action racing a payment attempt, etc. Prisma's
 * MongoDB provider doesn't enforce a cascade/restrict here (see
 * schema.prisma's Address/Order relation — it's a plain reference, not an
 * enforced FK), so nothing stops `Order.addressId` from quietly going
 * stale: the order row survives, it just no longer points at anything.
 *
 * Left unchecked, that isn't caught by detectOrderConflicts (which only
 * ever looks at products) and isn't caught by the stock decrement either —
 * both COD and Razorpay-order creation would sail straight through and
 * only fail once shipping.service.js's createShipmentForOrder tries to
 * read `order.address.name` off a null relation, by which point COD stock
 * has already been reserved or Razorpay money has already moved. Calling
 * this alongside detectOrderConflicts, before either of those happen, is
 * what makes an address deleted mid-checkout a clean, refusable 409
 * instead of a crash discovered downstream after the fact.
 *
 * @param {string} addressId
 * @param {string} userId
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} [client]
 * @returns {Promise<Array<object>>} conflicts — empty array if the address is still valid
 */
exports.detectAddressConflict = async (addressId, userId, client = prisma) => {
  const address = addressId
    ? await client.address.findUnique({ where: { id: addressId } })
    : null;

  if (!address || address.userId !== userId) {
    return [
      {
        type: 'address_unavailable',
        message:
          'The delivery address for this order is no longer available. Please choose a different address.',
      },
    ];
  }

  return [];
};


exports.createDraftOrderService  = async ( userId, selectedAddressId, couponCode = null, buyNowItem = null ) => {
  if (!userId) throw new CustomError('User ID is required', 404);

  if (selectedAddressId) {
    const address = await prisma.address.findUnique({ where: { id: selectedAddressId } });
    if (!address || address.userId !== userId) {
      throw new CustomError("Invalid or unauthorized address.", 404);
    }
  }

  return await prisma.$transaction(async (tx) => {
    let cartItems;

    if (buyNowItem) {
      // Buy Now bypasses the cart table entirely, but it must go through
      // the exact same server-side price/stock re-validation the cart path
      // gets below — that's what stops Buy Now from being the one checkout
      // path that trusts client-supplied price/quantity instead of live
      // Product data (see checkout-architecture.md §4.4/§5). The draft
      // order this produces has exactly one line item and fully replaces
      // whatever was in a prior draft order for this user (same
      // upsert-by-replacing-orderItems behavior as the cart path).
      const product = await tx.product.findUnique({
        where: { id: buyNowItem.productId },
      });

      if (!product || product.isDeleted) {
        throw new CustomError(
          'This item is no longer available.',
          409
        );
      }

      if (buyNowItem.quantity > product.stock) {
        throw new CustomError(
          'The requested quantity exceeds the available stock.',
          409,
          {
            insufficientStock: [{
              productId: product.id,
              name: product.name,
              requestedQuantity: buyNowItem.quantity,
              availableStock: product.stock,
            }],
          }
        );
      }

      cartItems = [
        { productId: product.id, quantity: buyNowItem.quantity, product },
      ];
    } else {
      const rawCartItems = await tx.cart.findMany({
        where: { userId },
        include: { product: true },
      });

      if (!rawCartItems || rawCartItems.length === 0) {
        throw new CustomError('No items found in cart', 404);
      }

      // This reads the cart table directly rather than going through
      // cart.service.getCart, so none of that module's guarantees apply here
      // for free — a row can still point at a product that's since been
      // soft-deleted (cart.service's own GET only sweeps these on read, and
      // draft-order creation can race that sweep) or whose stock has since
      // dropped below what's in the cart. Re-checking both here, right
      // before the order total is computed, is what actually makes "price
      // consistency" and "product availability" hold at checkout and not
      // just inside the cart CRUD endpoints — otherwise a stale/oversold
      // line item would silently ride along into the order total and only
      // surface (if at all) as an oversell warning after payment is captured
      // (see payment.service's decrementStockForOrder).
      const filteredCartItems = rawCartItems.filter((item) => item.product && !item.product.isDeleted);

      if (filteredCartItems.length === 0) {
        throw new CustomError(
          'The items in your cart are no longer available. Please review your cart.',
          409
        );
      }

      const insufficientStock = filteredCartItems
        .filter((item) => item.quantity > item.product.stock)
        .map((item) => ({
          productId: item.productId,
          name: item.product.name,
          requestedQuantity: item.quantity,
          availableStock: item.product.stock,
        }));

      if (insufficientStock.length > 0) {
        throw new CustomError(
          'Some items in your cart exceed the available stock. Please update your cart.',
          409,
          { insufficientStock }
        );
      }

      cartItems = filteredCartItems;
    }

    const subtotal = cartItems.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    // Single source of truth for the flat delivery-charge rule — see
    // src/constants/pricing.js. `total` (subtotal + deliveryCharge -
    // discount) is what payment.controller.js actually sends to Razorpay
    // and what shipping.service.js collects for COD, so computing it here
    // is what makes the amount the customer is charged match what the cart
    // page previewed, not just what the cart's line items sum to.
    const deliveryCharge = calculateDeliveryCharge(subtotal);
    // Discount/coupon placeholder — see calculateDiscount in
    // src/constants/pricing.js. Throws (rather than silently ignoring) if
    // couponCode is set but doesn't resolve to a real coupon, so a bad code
    // never gets to ride along into a draft order as if it had been
    // applied. No coupon system exists yet, so this is 0 on every order
    // today; the seam is here so that changes when one does.
    const discount = calculateDiscount(subtotal, couponCode);
    const total = Math.max(0, subtotal + deliveryCharge - discount);

    let draftOrder = await tx.order.findFirst({
      where: { userId, status: 'draft' },
      orderBy: { createdAt: 'desc' },
    });

    if (draftOrder) {
      await tx.orderItem.deleteMany({ where: { orderId: draftOrder.id } });

      await Promise.all(cartItems.map(item =>
        tx.orderItem.create({
          data: {
            orderId: draftOrder.id,
            productId: item.productId,
            quantity: item.quantity,
            price: item.product.price,
          },
        })
      ));

      draftOrder = await tx.order.update({
        where: { id: draftOrder.id },
        data: {
          total,
          subtotal,
          deliveryCharge,
          discount,
          couponCode: couponCode || null,
          addressId: selectedAddressId,
        },
      });
    } else {
      draftOrder = await tx.order.create({
        data: {
          userId,
          total,
          subtotal,
          deliveryCharge,
          discount,
          couponCode: couponCode || null,
          status: 'draft',
          addressId: selectedAddressId,
        },
      });

      await Promise.all(cartItems.map(item =>
        tx.orderItem.create({
          data: {
            orderId: draftOrder.id,
            productId: item.productId,
            quantity: item.quantity,
            price: item.product.price,
          },
        })
      ));
    }

    // Cart clearing happens once the order is actually confirmed (COD placed,
    // or payment verified/webhook-captured) — see payment.service.js. Doing
    // it here, at draft creation, would wipe the customer's cart before any
    // payment has happened, so an abandoned or failed checkout loses it for nothing.

    const fullOrder = await tx.order.findUnique({
      where: { id: draftOrder.id },
      include: {
        orderItems: {
          include: {
            product: true,
          },
        },
      },
    });

    return fullOrder;
  });
};


exports.getUserDraftOrder = async (userId) => {
  const draftOrder = await prisma.order.findFirst({
    where: {
      userId,
      status: 'draft'
    },
    select: {
      id: true,               // order ID
      userId: true,
      total: true,
      subtotal: true,
      deliveryCharge: true,
      discount: true,
      couponCode: true,
      status: true,
      createdAt: true,
      orderItems: {
        select: {
          id: true,
          quantity: true,
          product: {
            select: {
              id: true,
              name: true,
              price: true,
              images: true
            }
          }
        }
      }
    }
  });

  return draftOrder;
};


exports.getAllOrders = async () => {
  const ordersRaw = await prisma.order.findMany({
    include: {
      user: true,
      orderItems: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  // Format the data to match frontend expectations
  const orders = ordersRaw.map((order) => ({
  id: order.id,
  user: {
    id: order.userId,
    name: order.user?.name || "N/A",
  },
  createdAt: order.createdAt, // needed as-is
  total: order.total,
  subtotal: order.subtotal,
  deliveryCharge: order.deliveryCharge,
  discount: order.discount,
  couponCode: order.couponCode,
  status: order.status,
  paymentStatus: order.paymentStatus,
}));

  return orders;
};


exports.fetchOrderById = async (id) => {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          name: true,
        },
      },
      address: true,
      orderItems: {
        include: {
          product: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  return order;
};