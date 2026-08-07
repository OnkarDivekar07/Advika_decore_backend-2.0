const shippingService = require('./shipping.service');
const ekartClient = require('../../services/external/EkartClient');
const CustomError = require('@utils/customError');

exports.checkServiceability = async (req, res, next) => {
  try {
    const { pincode, paymentMode, weightKg } = req.body;

    const result = await shippingService.checkServiceability({
      destinationPincode: pincode,
      paymentMode,
      weightKg,
    });

    res.sendResponse({
      message: 'Serviceability checked successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.createShipment = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const result = await shippingService.createShipmentForOrder(orderId);

    res.sendResponse({
      message: result.alreadyProcessed
        ? 'Shipment already created for this order'
        : 'Shipment created successfully',
      data: result.shipment,
    });
  } catch (error) {
    next(error);
  }
};

exports.trackShipment = async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const result = await shippingService.trackOrderShipment(orderId, req.user);

    res.sendResponse({
      message: 'Shipment status fetched successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.cancelShipment = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const result = await shippingService.cancelOrderShipment(orderId, req.user, reason);

    res.sendResponse({
      message: 'Shipment cancelled successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 🔔 Ekart webhook — the source of truth for shipment status, mirroring how
// payment.controller.js's razorpayWebhook works. Fires from Ekart's servers
// whenever a shipment's status actually changes, independent of whether the
// frontend ever calls GET /track.
exports.ekartWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-ekart-signature']; // TODO: confirm actual header name from Ekart's webhook docs

    if (!req.rawBody) {
      throw new CustomError('Missing request body', 400);
    }

    const isValid = ekartClient.verifyWebhookSignature(req.rawBody, signature);
    if (!isValid) {
      throw new CustomError('Invalid webhook signature', 400);
    }

    await shippingService.handleEkartWebhookEvent(req.body);

    // Ack fast with a 2xx so Ekart doesn't keep retrying — we've already
    // applied the update.
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
};
