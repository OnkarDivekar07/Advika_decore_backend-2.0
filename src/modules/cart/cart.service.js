const prisma = require('@config/prisma');

const getCart = async (userId) => {
  return await prisma.cart.findMany({
    where: { userId },
    include: { product: true },
  });
};

const saveUserCart = async (userId, cartItems) => {
  // Optional: Clean existing cart
  await prisma.cart.deleteMany({ where: { userId } });

  const newCartData = cartItems.map((item) => ({
    userId,
    productId: item.productId,
    quantity: item.quantity,
  }));

  const res = await prisma.cart.createMany({ data: newCartData });
};

const updateCartItem = async (userId, productId, quantity) => {
  return await prisma.cart.updateMany({
    where: { userId, productId },
    data: { quantity },
  });
};

const removeFromCart = async (userId, productId) => {
  await prisma.cart.deleteMany({
    where: { userId, productId },
  });
};

module.exports = {
  getCart,
  saveUserCart,
  updateCartItem,
  removeFromCart,
};
