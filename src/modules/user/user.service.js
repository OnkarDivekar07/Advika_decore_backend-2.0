const prisma = require('@config/prisma');
const customError = require('@utils/customError');

exports.createAddress = async (data) => {
  return await prisma.address.create({ data });
};

exports.getAddressesByUserId = async (userId) => {
  return await prisma.address.findMany({
    where: { userId },
  });
};

exports.updateAddressById = async (id, userId, data) => {
  const address = await prisma.address.findFirst({
    where: { id, userId },
  });

  if (!address) {
    throw new customError('Address not found or unauthorized', 403);
  }

  return await prisma.address.update({
    where: { id },
    data,
  });
};

exports.deleteAddressById = async (id, userId) => {
  const address = await prisma.address.findFirst({
    where: { id, userId },
  });

  if (!address) {
    throw new customError('Address not found or unauthorized', 401);
  }
  return await prisma.address.delete({
    where: { id },
  });
};



exports.getUserProfile = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      address: true,
      createdAt: true
    }
  });

  if (!user) {
    throw new customError('User not found', 404);
  }

  return user;
};

