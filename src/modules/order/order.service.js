const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');
const { calculateDeliveryCharge, calculateDiscount } = require('@constants/pricing');


exports.createDraftOrderService  = async ( userId, selectedAddressId, couponCode = null ) => {
  if (!userId) throw new CustomError('User ID is required', 404);

  if (selectedAddressId) {
    const address = await prisma.address.findUnique({ where: { id: selectedAddressId } });
    if (!address || address.userId !== userId) {
      throw new CustomError("Invalid or unauthorized address.", 404);
    }
  }

  return await prisma.$transaction(async (tx) => {
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
    const cartItems = rawCartItems.filter((item) => item.product && !item.product.isDeleted);

    if (cartItems.length === 0) {
      throw new CustomError(
        'The items in your cart are no longer available. Please review your cart.',
        409
      );
    }

    const insufficientStock = cartItems
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