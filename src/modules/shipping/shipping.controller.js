const shippingService = require('./shipping.service');
const delhiveryClient = require('../../services/external/DelhiveryClient');
const CustomError = require('@utils/customError');

// Carrier isolation boundary: `raw` on a Shipment record is Delhivery's
// last unprocessed API/webhook payload, kept on our own row purely for
// internal debugging (see prisma/schema.prisma's comment on Shipment.raw)
// — every field the frontend actually needs (status, trackingId,
// lastLocation, estimatedDeliveryDate, ...) is already normalized onto the
// record itself. Stripped here, at the response boundary, so Delhivery's
// raw field names/shapes never reach the client even if
// DelhiveryClient.js's own response shape changes later.
function toPublicShipment(shipment) {
  if (!shipment) return shipment;
  const { raw, ...publicShipment } = shipment;
  return publicShipment;
}

exports.getDeliveryConfig = async (req, res, next) => {
  try {
    const result = shippingService.getDeliveryConfig();

    res.sendResponse({
      message: 'Delivery configuration fetched successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.checkServiceability = async (req, res, next) => {
  try {
    const { pincode, paymentMode, weightKg, subtotal } = req.body;

    const result = await shippingService.checkServiceability({
      destinationPincode: pincode,
      paymentMode,
      weightKg,
      subtotal,
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
      data: toPublicShipment(result.shipment),
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
      data: toPublicShipment(result),
    });
  } catch (error) {
    next(error);
  }
};

exports.cancelShipment = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const result = await shippingService.cancelOrderShipment(
      orderId,
      req.user,
      reason
    );

    res.sendResponse({
      message: 'Shipment cancelled successfully',
      data: toPublicShipment(result),
    });
  } catch (error) {
    next(error);
  }
};

// 🔔 Delhivery webhook — the source of truth for shipment status, mirroring
// how payment.controller.js's razorpayWebhook works. Fires from Delhivery's
// servers whenever a shipment's status actually changes, independent of
// whether the frontend ever calls GET /track.
exports.delhiveryWebhook = async (req, res, next) => {
  try {
    // Delhivery doesn't publish one universal webhook signature header the
    // way Razorpay does — this name is a placeholder pending confirmation
    // with Delhivery's integration team once webhook delivery is actually
    // configured for this account (see DelhiveryClient.verifyWebhookSignature's
    // note; shipment status stays accurate via polling either way).
    const signature = req.headers['x-delhivery-signature'];

    if (!req.rawBody) {
      throw new CustomError('Missing request body', 400);
    }

    const isValid = delhiveryClient.verifyWebhookSignature(
      req.rawBody,
      signature
    );
    if (!isValid) {
      throw new CustomError('Invalid webhook signature', 400);
    }

    await shippingService.handleDelhiveryWebhookEvent(req.body);

    // Ack fast with a 2xx so Delhivery doesn't keep retrying — we've
    // already applied the update.
    res.status(200).json({ received: true });
  } catch (error) {
    next(error);
  }
};
