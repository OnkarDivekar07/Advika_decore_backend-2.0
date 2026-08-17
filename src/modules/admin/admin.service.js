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

/**
 * Re-verify the currently-authenticated admin against the database.
 *
 * authenticate/authorizeAdminOnly (see @middlewares) only check the role
 * embedded in the JWT payload at the time it was signed — they never look
 * the user back up. That's fine as the per-request security boundary, but
 * it means a token stays "valid" for its full 1h lifetime even if the
 * admin's account is deleted or demoted in the meantime. This is the
 * backend-authoritative check the admin panel calls on load/refresh so a
 * stored token is never treated as proof of authorization by itself —
 * 401 here (via CustomError) is exactly the "session no longer valid"
 * signal the panel's apiClient already knows how to handle.
 */
exports.getCurrentAdmin = async (userId) => {
  const admin = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!admin || admin.role !== 'admin') {
    throw new CustomError('Admin session is no longer valid', 401);
  }

  return admin;
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
