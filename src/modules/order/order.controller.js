const orderService = require('./order.service');
const CustomError = require('@utils/customError');
const prisma = require('@config/prisma');

exports.createDraftOrder = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const { selectedAddressId } = req.body;
  
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


// GET /api/order
exports.getOrders = async (req, res, next) => {
  try {
    const orders = await orderService.getAllOrders();

    res.sendResponse({
      message: 'All orders fetched successfully',
      data: orders,
    });
  } catch (error) {
    next(error);
  }
};


// GET /api/order/:id
exports.getOrderById = async (req, res, next) => {
  const { id } = req.params;

  try {
    const order = await orderService.fetchOrderById(id);

    if (!order) {
      throw new CustomError('No draft order found.', 404);
    }

    res.sendResponse({
      message: 'Order fetched successfully',
      data: order,
    });
  } catch (error) {
    next(error);
  }
};
