const prisma = require('@config/prisma');
const {
  formatUser,
  formatUserDetail,
} = require('@utils/transformers/userTransformer');
const bcrypt = require('bcrypt');
const CustomError = require('@utils/customError');
const generateToken = require('@utils/generateToken');
const paginateWithCache = require('@utils/paginateWithCache');
// Reused (not re-implemented) for the low-stock slice of PHASE 14's
// operational alerts feed below — inventory.service.js's
// listLowStockProducts is already the backend-authoritative "what needs
// restocking" query (used by Inventory.jsx today); admin.alerts just
// folds its result into the wider alerts payload instead of duplicating
// the threshold/selection logic here.
const inventoryService = require('@modules/inventory/inventory.service');
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
    // Minimal admin query extension: ?search= matches name/email/phone via
    // paginateWithCache's existing generic OR-contains support (see
    // @utils/paginateWithCache) — no bespoke filtering logic added here,
    // just opting this listing into a mechanism every other admin list
    // (Orders, Products) already uses. Validated/sanitized in
    // admin.validation.js before this ever runs.
    searchableFields: ['name', 'email', 'phone'],
    cachePrefix: 'allUsersWithStats',
    // Left disabled (as before this change): a cached page could serve a
    // stale ?search= result under a colliding key, and this listing isn't
    // hot enough to need it. See paginateWithCache.js's cacheKey — search
    // is already folded in for if this is ever turned back on.
    cache: false,
    cacheExpiry: 300, // in seconds
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
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

// Recent-orders cap for the customer detail view — a summary, not a full
// order ledger (an admin wanting the complete history for one customer can
// already do that via Orders.jsx's search-by-email, which hits the real
// paginated /api/orders/all). Keeps this endpoint's payload bounded even
// for a customer with hundreds of orders.
const USER_DETAIL_RECENT_ORDERS_LIMIT = 10;

/**
 * Single-customer detail view for the admin panel. Only ever reads via a
 * Prisma `select` (never the raw row), so there is no password/OTP/token
 * field this can leak even by accident — see userTransformer.js's
 * formatUserDetail, which is like formatUser but also line up the fuller
 * per-order breakdown for a "view customer" screen where a bare
 * total/date summary isn't enough.
 */
exports.getUserDetailById = async (id) => {
  const [user, orderAgg] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
        addresses: {
          select: {
            id: true,
            name: true,
            phone: true,
            houseArea: true,
            area: true,
            city: true,
            state: true,
            pincode: true,
            landmark: true,
            deliveryInstructions: true,
            isDefault: true,
          },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        },
        orders: {
          select: {
            id: true,
            status: true,
            paymentStatus: true,
            total: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: USER_DETAIL_RECENT_ORDERS_LIMIT,
        },
      },
    }),
    // Full-history totals, computed independently of the capped
    // `recentOrders` above so orderSummary stays accurate for customers
    // with more than USER_DETAIL_RECENT_ORDERS_LIMIT orders.
    prisma.order.aggregate({
      where: { userId: id },
      _count: { _all: true },
      _sum: { total: true },
    }),
  ]);

  if (!user) return null;

  return formatUserDetail(user, {
    totalOrders: orderAgg._count._all,
    totalSpent: orderAgg._sum.total || 0,
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

  // Both failure branches below throw the exact same message/status. A
  // distinct "no such admin" vs "wrong password" message lets anyone
  // enumerate valid admin emails for free by just watching which text
  // comes back — a real, low-cost account-enumeration vector against a
  // login endpoint that only guards a handful of admin accounts. Neither
  // branch tells the caller anything about *why* it failed.
  if (!admin || admin.role !== 'admin') {
    throw new CustomError('Invalid email or password', 401);
  }

  const isMatch = await bcrypt.compare(password, admin.password);
  if (!isMatch) {
    throw new CustomError('Invalid email or password', 401);
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

// --- PHASE 14 — Operational Alerts & Notifications --------------------------
//
// Every section below is a direct, real-time read of already-existing
// operational state (Product.stock, Order.status/paymentStatus,
// Shipment.status) — there is no separate "alert" record anywhere and
// nothing here is ever synthesized. An "alert" is just a name for "a real
// row currently sitting in one of these states"; closing it out (restocking
// a product, confirming/shipping an order, resolving a failed payment or a
// failed delivery) makes it stop appearing here on the very next read —
// there's no separate dismiss/acknowledge action or stored state to keep in
// sync with that.
//
// No read/unread tracking: nothing in the schema persists an
// admin-acknowledged flag for an order, a shipment, or a product, and
// notification.service.js (order-confirmation SMS) never did either — it's
// a one-shot outbound send, not a feed with per-recipient state. Bolting a
// read/unread flag onto this endpoint would mean inventing storage the
// backend doesn't have, which is exactly the kind of frontend workaround
// this phase is not supposed to introduce. If per-admin read/unread state
// is wanted later, it needs a real backend model behind it, not a client
// guess.
const ALERT_LIST_CAP = 10;
const DEFAULT_LOW_STOCK_THRESHOLD = 10;

// Payment states that need a human look, as already defined by
// PaymentStatus's own doc comment in prisma/schema.prisma: 'failed' (an
// attempt Razorpay rejected), 'timeout' (an attempt that went stale and was
// never captured), and 'unknown' (reconciliation couldn't confirm either
// way, e.g. Razorpay was unreachable). Deliberately excludes 'cancelled'
// (the customer closed checkout themselves — not a failure) and the normal
// in-flight/terminal states ('pending', 'attempted', 'processing', 'paid',
// 'cod_pending', 'refunded').
const PAYMENT_EXCEPTION_STATUSES = ['failed', 'timeout', 'unknown'];

// Shipment states that need operational attention: a courier-reported
// delivery failure, or a return-to-origin already in motion. Excludes the
// normal forward-progress states (CREATED/PICKED_UP/IN_TRANSIT/
// OUT_FOR_DELIVERY/DELIVERED) and states that don't need further action
// (RTO_DELIVERED — the return already completed; CANCELLED — an
// intentional cancellation, not a failure).
const SHIPMENT_EXCEPTION_STATUSES = ['DELIVERY_FAILED', 'RTO_INITIATED'];

/**
 * Aggregates real, currently-true operational conditions into a single
 * "needs attention" feed for the admin panel: low-stock products, orders
 * still awaiting confirmation, payment attempts that need a human look, and
 * shipments that failed or are being returned to origin. Each section's
 * `count` is the true total (for badges); `items` is capped at
 * ALERT_LIST_CAP, oldest/most-recent-first as appropriate, since this is a
 * "what needs attention right now" panel, not a paginated browser — an
 * admin who needs the full list already has Inventory.jsx (low stock) and
 * Orders.jsx (status/paymentStatus filters) for that.
 */
exports.getOperationalAlerts = async ({
  lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD,
} = {}) => {
  const [
    lowStockProducts,
    pendingOrdersCount,
    pendingOrdersList,
    paymentExceptionsCount,
    paymentExceptionsList,
    shipmentExceptionsCount,
    shipmentExceptionsList,
  ] = await Promise.all([
    // Already capped internally (LOW_STOCK_LIST_CAP) — not re-capped to
    // ALERT_LIST_CAP, since an admin adjusting the threshold on this panel
    // expects the same result Inventory.jsx would show for it.
    inventoryService.listLowStockProducts(lowStockThreshold),

    prisma.order.count({ where: { status: 'pending' } }),
    prisma.order.findMany({
      where: { status: 'pending' },
      // Oldest first — the longest-waiting order is the most urgent one to
      // confirm/act on.
      orderBy: { createdAt: 'asc' },
      take: ALERT_LIST_CAP,
      select: {
        id: true,
        total: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),

    prisma.order.count({
      where: { paymentStatus: { in: PAYMENT_EXCEPTION_STATUSES } },
    }),
    prisma.order.findMany({
      where: { paymentStatus: { in: PAYMENT_EXCEPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: ALERT_LIST_CAP,
      select: {
        id: true,
        total: true,
        paymentStatus: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),

    prisma.shipment.count({
      where: { status: { in: SHIPMENT_EXCEPTION_STATUSES } },
    }),
    prisma.shipment.findMany({
      where: { status: { in: SHIPMENT_EXCEPTION_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      take: ALERT_LIST_CAP,
      select: {
        orderId: true,
        trackingId: true,
        status: true,
        courierPartner: true,
        lastLocation: true,
        updatedAt: true,
      },
    }),
  ]);

  // Shipment isn't a declared Prisma relation on Order (see
  // prisma/schema.prisma's comment on the Shipment model), so the
  // customer/order-total context for shipmentExceptions is batch-joined in
  // memory here — same pattern order.service.js's getAllOrders already
  // uses in the opposite direction (Order -> Shipment).
  const exceptionOrderIds = shipmentExceptionsList.map((s) => s.orderId);
  const relatedOrders = exceptionOrderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: exceptionOrderIds } },
        select: {
          id: true,
          total: true,
          user: { select: { name: true, email: true } },
        },
      })
    : [];
  const orderById = new Map(relatedOrders.map((o) => [o.id, o]));

  return {
    lowStock: {
      threshold: lowStockThreshold,
      count: lowStockProducts.length,
      items: lowStockProducts,
    },
    pendingOrders: {
      count: pendingOrdersCount,
      items: pendingOrdersList.map((order) => ({
        id: order.id,
        total: order.total,
        createdAt: order.createdAt,
        user: {
          name: order.user?.name || 'N/A',
          email: order.user?.email || null,
        },
      })),
    },
    paymentExceptions: {
      count: paymentExceptionsCount,
      items: paymentExceptionsList.map((order) => ({
        id: order.id,
        total: order.total,
        paymentStatus: order.paymentStatus,
        createdAt: order.createdAt,
        user: {
          name: order.user?.name || 'N/A',
          email: order.user?.email || null,
        },
      })),
    },
    shipmentExceptions: {
      count: shipmentExceptionsCount,
      items: shipmentExceptionsList.map((shipment) => {
        const order = orderById.get(shipment.orderId);
        return {
          orderId: shipment.orderId,
          trackingId: shipment.trackingId,
          status: shipment.status,
          courierPartner: shipment.courierPartner,
          lastLocation: shipment.lastLocation,
          updatedAt: shipment.updatedAt,
          total: order?.total ?? null,
          user: order
            ? {
                name: order.user?.name || 'N/A',
                email: order.user?.email || null,
              }
            : null,
        };
      }),
    },
    generatedAt: new Date().toISOString(),
  };
};
