const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');


exports.createDraftOrderService  = async ( userId, selectedAddressId ) => {
  if (!userId) throw new CustomError('User ID is required', 404);

  if (selectedAddressId) {
    const address = await prisma.address.findUnique({ where: { id: selectedAddressId } });
    if (!address || address.userId !== userId) {
      throw new CustomError("Invalid or unauthorized address.", 404);
    }
  }

  return await prisma.$transaction(async (tx) => {
    const cartItems = await tx.cart.findMany({
      where: { userId },
      include: { product: true },
    });

    if (!cartItems || cartItems.length === 0) {
      throw new CustomError('No items found in cart', 404);
    }

    const total = cartItems.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

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
          addressId: selectedAddressId,
        },
      });
    } else {
      draftOrder = await tx.order.create({
        data: {
          userId,
          total,
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