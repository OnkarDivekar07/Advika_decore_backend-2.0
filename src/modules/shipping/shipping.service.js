const prisma = require('@config/prisma');
const CustomError = require('@utils/customError');
const ekartClient = require('../../services/external/EkartClient');

const EKART_PICKUP_LOCATION_CODE = process.env.EKART_PICKUP_LOCATION_CODE;
const EKART_PICKUP_PINCODE = process.env.EKART_PICKUP_PINCODE;

// Fallback used when a product has no declared weight yet (Product model
// doesn't carry a weight field today). Swap this out once that's added —
// left as a constant here rather than touching the Product schema.
const DEFAULT_ITEM_WEIGHT_KG = 0.5;

// Maps Ekart's raw status codes to our internal ShipmentStatus enum.
// TODO: fill this in against Ekart's real status code list from their docs
// (left side = Ekart's raw code/string, right side = our enum value).
const RAW_TO_SHIPMENT_STATUS = {
  MANIFESTED: 'CREATED',
  PICKED: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  UNDELIVERED: 'DELIVERY_FAILED',
  RTO: 'RTO_INITIATED',
  RTO_DELIVERED: 'RTO_DELIVERED',
  CANCELLED: 'CANCELLED',
};

function mapEkartStatus(rawStatus) {
  return RAW_TO_SHIPMENT_STATUS[rawStatus] || 'CREATED';
}

// A subset of shipment statuses that should also move the underlying Order
// forward/back. In-transit style statuses intentionally aren't listed —
// the order just stays 'shipped' until something conclusive happens.
const SHIPMENT_TO_ORDER_STATUS = {
  DELIVERED: 'delivered',
  RTO_DELIVERED: 'returned',
  CANCELLED: 'cancelled',
};

async function syncOrderStatusFromShipment(orderId, shipmentStatus) {
  const orderStatus = SHIPMENT_TO_ORDER_STATUS[shipmentStatus];
  if (!orderStatus) return;

  try {
    await prisma.order.update({ where: { id: orderId }, data: { status: orderStatus } });
  } catch (error) {
    console.warn(`[shipping] Failed to sync order ${orderId} status to '${orderStatus}':`, error.message);
  }
}

/**
 * Check pincode serviceability + delivery estimate. Called from the
 * checkout/product page, before an order even exists.
 */
exports.checkServiceability = async ({ destinationPincode, paymentMode = 'PREPAID', weightKg }) => {
  const response = await ekartClient.checkServiceability({
    originPincode: EKART_PICKUP_PINCODE,
    destinationPincode,
    paymentMode,
    weightKg,
  });

  return {
    serviceable: Boolean(response?.serviceable ?? response?.is_serviceable),
    estimatedDays: response?.estimated_delivery_days ?? response?.sla_days ?? null,
    codAvailable: Boolean(response?.cod_available),
  };
};

/**
 * Create a shipment with Ekart for a confirmed order, and persist the
 * resulting tracking ID against it. Idempotent — calling this again for an
 * order that already has a shipment just returns the existing one, the
 * same pattern payment.service.js uses for alreadyProcessed.
 */
exports.createShipmentForOrder = async (orderId) => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { orderItems: { include: { product: true } }, address: true },
  });

  if (!order) {
    throw new CustomError('Order not found', 404);
  }

  if (order.status !== 'confirmed') {
    throw new CustomError(
      `Cannot ship an order with status '${order.status}' — only confirmed orders can be shipped`,
      400
    );
  }

  const existingShipment = await prisma.shipment.findUnique({ where: { orderId } });
  if (existingShipment) {
    return { shipment: existingShipment, alreadyProcessed: true };
  }

  const paymentMode = order.paymentStatus === 'cod_pending' ? 'COD' : 'PREPAID';
  const codAmount = paymentMode === 'COD' ? order.total : 0;

  const totalWeightKg = order.orderItems.reduce(
    (sum, item) => sum + (item.product?.weightKg || DEFAULT_ITEM_WEIGHT_KG) * item.quantity,
    0
  );

  // TODO: confirm this payload shape against Ekart's "Create Shipment" doc.
  const ekartResponse = await ekartClient.createShipment({
    order_id: order.id,
    payment_mode: paymentMode,
    cod_amount: codAmount,
    pickup_location_code: EKART_PICKUP_LOCATION_CODE,
    consignee: {
      name: order.address.name,
      phone: order.address.phone,
      address: order.address.houseArea,
      landmark: order.address.landmark || undefined,
      city: order.address.city,
      state: order.address.state,
      pincode: order.address.pincode,
    },
    items: order.orderItems.map((item) => ({
      sku: item.productId,
      name: item.product?.name,
      quantity: item.quantity,
      unit_price: item.price,
    })),
    weight: totalWeightKg,
  });

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      trackingId: ekartResponse?.tracking_id ?? ekartResponse?.awb_number,
      awbNumber: ekartResponse?.awb_number,
      status: 'CREATED',
      paymentMode,
      codAmount,
      pickupLocationCode: EKART_PICKUP_LOCATION_CODE,
      raw: ekartResponse,
    },
  });

  // Reflect progress on the order itself too, so existing order views that
  // don't know about the Shipment model still show something meaningful.
  await prisma.order.update({ where: { id: order.id }, data: { status: 'shipped' } });

  return { shipment, alreadyProcessed: false };
};

/**
 * Fetch the latest status for an order's shipment, polling Ekart and
 * refreshing our own record. Restricted to the order's owner or an admin.
 */
exports.trackOrderShipment = async (orderId, requestingUser) => {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new CustomError('Order not found', 404);
  }

  const isOwner = order.userId === requestingUser.userId;
  const isAdmin = requestingUser.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw new CustomError('Not authorized to view this shipment', 403);
  }

  const shipment = await prisma.shipment.findUnique({ where: { orderId } });
  if (!shipment) {
    throw new CustomError('No shipment found for this order yet', 404);
  }

  if (!shipment.trackingId) {
    // Shipment record exists but Ekart hasn't returned a tracking ID yet —
    // nothing to poll for.
    return shipment;
  }

  const tracking = await ekartClient.trackShipment(shipment.trackingId);
  const status = mapEkartStatus(tracking?.status_code ?? tracking?.status);

  const updated = await prisma.shipment.update({
    where: { orderId },
    data: {
      status,
      lastLocation: tracking?.current_location ?? shipment.lastLocation,
      lastSyncedAt: new Date(),
      raw: tracking,
    },
  });

  await syncOrderStatusFromShipment(order.id, status);

  return updated;
};

/**
 * Cancel a shipment before it's out for delivery. Restricted to the
 * order's owner or an admin, same as tracking.
 */
exports.cancelOrderShipment = async (orderId, requestingUser, reason) => {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new CustomError('Order not found', 404);
  }

  const isOwner = order.userId === requestingUser.userId;
  const isAdmin = requestingUser.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw new CustomError('Not authorized to cancel this shipment', 403);
  }

  const shipment = await prisma.shipment.findUnique({ where: { orderId } });
  if (!shipment) {
    throw new CustomError('No shipment found for this order', 404);
  }

  if (['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'].includes(shipment.status)) {
    throw new CustomError(`Cannot cancel a shipment that is already '${shipment.status}'`, 400);
  }

  if (shipment.trackingId) {
    await ekartClient.cancelShipment(shipment.trackingId, reason || 'Customer requested cancellation');
  }

  const updated = await prisma.shipment.update({ where: { orderId }, data: { status: 'CANCELLED' } });
  await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });

  return updated;
};

/**
 * Apply a verified Ekart webhook event to our shipment + order records.
 * Same reconciliation role as payment.service.js's handleRazorpayWebhookEvent:
 * runs independently of whether/when the client polls /track, and is safe
 * to receive more than once for the same event.
 */
exports.handleEkartWebhookEvent = async (payload) => {
  const trackingId = payload?.tracking_id ?? payload?.awb_number;
  if (!trackingId) {
    // Nothing to reconcile against — ack and ignore.
    return;
  }

  const shipment = await prisma.shipment.findUnique({ where: { trackingId } });
  if (!shipment) {
    console.warn(`[shipping] Webhook received for unknown tracking ID: ${trackingId}`);
    return;
  }

  const status = mapEkartStatus(payload?.status_code ?? payload?.status);

  await prisma.shipment.update({
    where: { trackingId },
    data: {
      status,
      lastLocation: payload?.current_location ?? shipment.lastLocation,
      lastSyncedAt: new Date(),
      raw: payload,
    },
  });

  await syncOrderStatusFromShipment(shipment.orderId, status);
};
