const prisma = require('@config/prisma');
const { formatUser } = require('@utils/transformers/userTransformer');
const bcrypt = require('bcrypt');
const CustomError = require('@utils/customError');
const generateToken = require('@utils/generateToken');
const paginateWithCache = require('@utils/paginateWithCache');
/**
 * Fetch platform-wide admin statistics
 */
exports.getAdminStats = async () => {
  const [
    totalUsers,
    totalOrders,
    totalProducts,
    deliveredOrders,
    pendingOrders,
    totalRevenueResult,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'customer' } }),
    prisma.order.count({ where: { status: 'confirmed' } }),
    prisma.product.count({ where: { isDeleted: false } }),
    prisma.order.count({ where: { status: 'delivered' } }),
    prisma.order.count({ where: { status: 'pending' } }),
    prisma.order.aggregate({
      where: { paymentStatus: 'paid' },
      _sum: { total: true },
    }),
  ]);

  return {
    totalUsers,
    totalOrders,
    totalProducts,
    deliveredOrders,
    pendingOrders,
    totalRevenue: totalRevenueResult._sum.total || 0,
  };
};

exports.getAllUsersWithStats = (req) => {
  return paginateWithCache({
    model: prisma.user,
    req,
    where: req.query.role ? { role: req.query.role } : { role: 'customer' },
    orderBy: {
      [req.query.sort || 'createdAt']:
        req.query.order === 'asc' ? 'asc' : 'desc',
    },
    cachePrefix: 'allUsersWithStats',
    cache: false,
    cacheExpiry: 300, // in seconds
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
      addresses: {
        select: {
          houseArea: true,
          area: true,
          city: true,
          state: true,
          pincode: true,
          isDefault: true,
        },
      },
      orders: {
        select: {
          total: true,
          createdAt: true,
        },
      },
    },
    formatter: (user) => formatUser(user),
  });
};

exports.login = async ({ email, password }) => {
  const admin = await prisma.user.findUnique({
    where: { email },
  });

  if (!admin || admin.role !== 'admin') {
    throw new CustomError('Invalid email or not an admin', 401);
  }

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch) {
    throw new CustomError('Incorrect password', 401);
  }

  const token = generateToken(admin.id, admin.role);

  return {
    token,
    user: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
  };
};
