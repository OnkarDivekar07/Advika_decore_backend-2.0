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
    joinedOn: user.createdAt,
    addresses: user.addresses,
    totalOrders,
    totalSpent,
    lastOrderDate,
  };
};
