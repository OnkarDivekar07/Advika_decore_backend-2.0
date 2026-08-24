const orderService = require('./order.service');
const CustomError = require('@utils/customError');
const prisma = require('@config/prisma');

exports.createDraftOrder = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    // SECURITY INVARIANT: only these three fields are ever read off the
    // request body. deliveryCharge/subtotal/total/discount/price/amount —
    // or anything else price-shaped — must NEVER be destructured here or
    // passed through to orderService.createDraftOrderService below. Every
    // number that ends up on the order (subtotal, deliveryCharge, discount,
    // total — and, downstream, what Razorpay/COD actually charges) is
    // computed server-side from live cart/product data (see
    // order.service.js / src/constants/pricing.js's calculateDeliveryCharge)
    // — never trusted from the client. See
    // tests/integration/order.routes.test.js's "ignores a client-supplied
    // deliveryCharge/subtotal/total/discount" test for the regression check.
    const { selectedAddressId, couponCode, buyNow } = req.body;

    if (!userId) {
      throw new CustomError('Unauthorized access. User ID missing.', 401);
    }

    if (!selectedAddressId) {
      throw new CustomError('Address ID is required', 400);
    }

    const address = await prisma.address.findUnique({
      where: { id: selectedAddressId },
    });

    if (!address || address.userId !== userId) {
      throw new CustomError('Invalid address selection', 403);
    }

    const order = await orderService.createDraftOrderService(
      userId,
      selectedAddressId,
      couponCode || null,
      buyNow || null
    );

    return res.sendResponse({
      statusCode: 201,
      message: 'Draft order created/updated successfully.',
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/order/draft
exports.getUserOrders = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const orders = await orderService.getUserDraftOrder(userId);

    if (!orders) {
      throw new CustomError('No draft order found.', 404);
    }

    res.sendResponse({
      message: 'Draft order fetched successfully',
      data: orders,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/order/history
// Paginated "My Orders" list for the logged-in user — placed orders only
// (never the in-progress draft order GET /api/order returns). page/limit
// are already shape-validated by validateOrderHistoryQuery; the service
// layer still clamps them defensively (see order.service.js).
exports.getOrderHistory = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { page, limit } = req.query;

    const { orders, meta } = await orderService.getUserOrderHistory(userId, {
      page,
      limit,
    });

    res.sendResponse({
      message: 'Order history fetched successfully',
      data: orders,
      meta,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/orders/all (Admin) — paginated, filterable order workbench
// list. page/limit/status/paymentStatus/dateFrom/dateTo/search are already
// shape/enum-validated by validateOrderListQuery; getAllOrders still
// clamps/re-checks them defensively (see order.service.js).
exports.getOrders = async (req, res, next) => {
  try {
    const { page, limit, status, paymentStatus, dateFrom, dateTo, search } =
      req.query;

    const { orders, meta } = await orderService.getAllOrders({
      page,
      limit,
      status,
      paymentStatus,
      dateFrom,
      dateTo,
      search,
    });

    res.sendResponse({
      message: 'All orders fetched successfully',
      data: orders,
      meta,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/order/:id
// Owner-or-admin: any authenticated customer can fetch their own order by id
// (needed for the order-confirmation/success page — see
// checkout-architecture.md §4.2), admins can fetch any order.
exports.getOrderById = async (req, res, next) => {
  const { id } = req.params;
  const { userId, role } = req.user;

  try {
    const order = await orderService.fetchOrderById(id);

    if (!order) {
      throw new CustomError('No draft order found.', 404);
    }

    if (role !== 'admin' && order.userId !== userId) {
      throw new CustomError('You do not have access to this order.', 403);
    }

    res.sendResponse({
      message: 'Order fetched successfully',
      data: order,
    });
  } catch (error) {
    next(error);
  }
};
