// Picks a single "relevant" address to summarize a user in list views —
// the default address when the user has one, otherwise whichever address
// comes first. Never returns more than one address here; the full list is
// only exposed via the customer detail view (formatUserDetail below).
const pickAddressSummary = (addresses = []) => {
  if (!addresses.length) return null;
  const defaultAddress = addresses.find((addr) => addr.isDefault);
  const { isDefault, ...address } = defaultAddress || addresses[0];
  return address;
};

// Used by GET /api/admin/users (admin.service.js's getAllUsersWithStats).
// Deliberately whitelist-only: `user` here is already a Prisma `select`
// result (never the raw row with `password`), but this stays explicit
// about exactly which fields reach the admin panel rather than
// spreading `...user`, so a future field added to that `select` doesn't
// silently start rendering in the users table.
exports.formatUser = (user) => {
  const totalOrders = user.orders.length;
  const totalSpent = user.orders.reduce(
    (sum, order) => sum + (order.total || 0),
    0
  );
  const lastOrderDate = user.orders.reduce(
    (latest, order) =>
      new Date(order.createdAt) > new Date(latest || 0)
        ? order.createdAt
        : latest,
    null
  );

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    joinedOn: user.createdAt,
    addressSummary: pickAddressSummary(user.addresses),
    totalOrders,
    totalSpent,
    lastOrderDate,
  };
};

// Used by GET /api/admin/users/:id (admin.service.js's getUserDetailById).
// `user` here already excludes `password` at the Prisma `select` level —
// see admin.service.js — so there is no credential to accidentally leak
// even if this formatter is ever loosened later. orderSummary is computed
// separately (from a full aggregate, not just `recentOrders`) so it stays
// accurate even once a customer has more orders than the recent-orders cap.
exports.formatUserDetail = (user, orderSummary) => {
  const { orders, addresses, createdAt, ...rest } = user;

  return {
    ...rest,
    joinedOn: createdAt,
    addresses: addresses || [],
    recentOrders: orders || [],
    orderSummary,
  };
};
