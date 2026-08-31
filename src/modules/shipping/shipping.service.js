const prisma = require('@config/prisma');
const logger = require('@config/logger');
const CustomError = require('@utils/customError');
const delhiveryClient = require('../../services/external/DelhiveryClient');
const {
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_CHARGE,
  calculateDeliveryCharge,
} = require('@constants/pricing');
const { isValidIndianPincodeFormat } = require('@constants/pincode');
const { shippingServiceabilityFallbackPolicy } = require('@config/env');

const DELHIVERY_PICKUP_LOCATION_NAME = process.env.DELHIVERY_PICKUP_LOCATION_NAME;
const DELHIVERY_SELLER_NAME = process.env.DELHIVERY_SELLER_NAME;

// Fallback used when a product has no declared weight yet (Product model
// doesn't carry a weight field today). Swap this out once that's added —
// left as a constant here rather than touching the Product schema.
const DEFAULT_ITEM_WEIGHT_KG = 0.5;

// Maps Delhivery's raw shipment status strings (ShipmentData[0].Shipment.
// Status.Status from the tracking API) to our internal ShipmentStatus
// enum. This vocabulary reflects Delhivery's long-standing, publicly
// documented status terminology — high confidence on the general set, but
// exact spelling/casing should be smoke-tested against a real account
// before relying on it, same as the rest of this integration (see
// DelhiveryClient.js's header note).
const RAW_TO_SHIPMENT_STATUS = {
  Manifested: 'CREATED',
  'Not Picked': 'CREATED',
  'Pickup Scheduled': 'CREATED',
  'Picked Up': 'PICKED_UP',
  'In Transit': 'IN_TRANSIT',
  Pending: 'IN_TRANSIT',
  Dispatched: 'OUT_FOR_DELIVERY',
  'Out for Delivery': 'OUT_FOR_DELIVERY',
  Delivered: 'DELIVERED',
  Undelivered: 'DELIVERY_FAILED',
  Lost: 'DELIVERY_FAILED',
  RTO: 'RTO_INITIATED',
  'RTO Initiated': 'RTO_INITIATED',
  'RTO Delivered': 'RTO_DELIVERED',
  'Return Delivered': 'RTO_DELIVERED',
  Cancelled: 'CANCELLED',
  Canceled: 'CANCELLED',
};

function mapDelhiveryStatus(rawStatus) {
  return RAW_TO_SHIPMENT_STATUS[rawStatus] || 'CREATED';
}

// Delhivery's tracking response nests an explicit expected-delivery date
// under ShipmentData[0].Shipment (see trackShipment/webhook call sites,
// which pass that nested `.Shipment` object in here directly) as
// `ExpectedDeliveryDate` — Delhivery's serviceability lookup itself
// doesn't return an SLA day-count at all (unlike the earlier, unverified
// Ekart assumption), so there's no day-count fallback to derive a date
// from at shipment-creation time; `estimatedDeliveryDate` legitimately
// stays null until the first real tracking poll reports one.
function extractEstimatedDeliveryDate(delhiveryShipment) {
  const rawDate = delhiveryShipment?.ExpectedDeliveryDate ?? null;
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

// A subset of shipment statuses that should also move the underlying Order
// forward/back. In-transit style statuses intentionally aren't listed —
// the order just stays 'shipped' until something conclusive happens.
const SHIPMENT_TO_ORDER_STATUS = {
  DELIVERED: 'delivered',
  RTO_DELIVERED: 'returned',
  CANCELLED: 'cancelled',
};

// Once a shipment reaches one of these, nothing should ever move it back
// out — confirmed live: Delhivery's own tracking API reports a
// cancelled-before-pickup shipment's Status.Status as "Not Picked" (mapped
// to CREATED, see RAW_TO_SHIPMENT_STATUS), not "Cancelled". Without this
// guard, a customer or admin simply reloading the tracking page after a
// cancellation would silently flip the record right back to CREATED on
// the next poll — trackOrderShipment/handleDelhiveryWebhookEvent both
// check this before applying anything Delhivery reports.
const TERMINAL_SHIPMENT_STATUSES = ['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'];

async function syncOrderStatusFromShipment(orderId, shipmentStatus) {
  const orderStatus = SHIPMENT_TO_ORDER_STATUS[shipmentStatus];
  if (!orderStatus) return;

  try {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: orderStatus },
    });
  } catch (error) {
    logger.warn(
      `[shipping] Failed to sync order ${orderId} status to '${orderStatus}': ${error.message}`
    );
  }
}

/**
 * Read-only mirror of the backend's flat delivery-charge rule (see
 * src/constants/pricing.js / src/config/env.js) for pages that need to show
 * a delivery estimate before a cart/draft order exists to ask instead — the
 * product page, and an anonymous/guest cart with nothing to fetch from
 * /api/cart yet. Deliberately just re-exports the same two numbers
 * order.service.js and cart.service.js already compute against, rather than
 * a second copy of them, so a config change (env var edit) is reflected
 * here automatically with nothing else to keep in sync.
 */
exports.getDeliveryConfig = () => ({
  freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
  deliveryCharge: DELIVERY_CHARGE,
});

// Optionally folds the delivery-charge/free-delivery side of the
// normalized shipping contract onto a serviceability result — see
// checkServiceability's docs. `subtotal` is only ever provided by a
// caller that already has one to price against (the cart/checkout page);
// everything else (order.service.js's detectAddressConflict,
// checkDeliveryEligibility's fail-open branch, every existing caller
// today) omits it and gets back exactly `base`, untouched — this is
// additive enrichment, never a change to the base contract.
function withPricing(base, subtotal) {
  if (
    typeof subtotal !== 'number' ||
    !Number.isFinite(subtotal) ||
    subtotal < 0
  ) {
    return base;
  }
  const deliveryCharge = calculateDeliveryCharge(subtotal);
  return {
    ...base,
    deliveryCharge,
    freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
    freeDeliveryEligible: deliveryCharge === 0,
  };
}

// Distinct reasons a pincode can come back not-serviceable, so callers can
// react to (and word) each case differently instead of one generic
// "we don't deliver here":
//   INVALID_FORMAT    — empty, or doesn't even look like a 6-digit Indian
//                        pincode (see src/constants/pincode.js). Caught
//                        entirely locally, before ever calling Delhivery —
//                        there's nothing for the carrier to answer about
//                        "abc123" or "". The route-level validator (see
//                        shipping.validation.js) already rejects this for
//                        the public /serviceability endpoint, but this
//                        check is repeated here as the real backend
//                        guarantee: checkServiceability is also called
//                        directly from order.service.js's
//                        detectAddressConflict at order-confirmation time,
//                        which never goes through that route middleware at
//                        all, so a malformed/blank pincode on a stored
//                        address must still be caught here rather than
//                        silently reaching Delhivery or slipping through.
//   INVALID_PINCODE   — well-formed (passes the shape check above), but
//                       Delhivery's pincode lookup returns no entry for it
//                       at all (isn't a real Indian PIN in their system —
//                       a typo, or a code that simply doesn't exist). This
//                       comes back as a normal empty `delivery_codes`
//                       array, not an error — see
//                       DelhiveryClient.checkServiceability.
//   AREA_NOT_COVERED  — currently unused for Delhivery: its pincode
//                       lookup doesn't distinguish "recognized but not
//                       delivered to" from "not recognized" the way the
//                       earlier (unverified) Ekart assumption implied —
//                       an unrecognized entry is the only "no" it returns.
//                       Kept in the enum since it's still part of the
//                       stable contract callers (frontend included) rely
//                       on, and may become reachable again if a future
//                       Delhivery lookup call distinguishes the two.
//   CHECK_UNAVAILABLE — never returned by checkServiceability itself (which
//                       always throws a 503 rather than guessing — see its
//                       own docs below). Only ever produced by
//                       checkDeliveryEligibility's fail-closed fallback
//                       (see SHIPPING_SERVICEABILITY_FALLBACK_POLICY in
//                       src/config/env.js) when the carrier check couldn't
//                       get an answer at all and policy says that should
//                       block rather than pass through. Kept distinct from
//                       AREA_NOT_COVERED so a caller — and the customer —
//                       is never told "we don't deliver here" about a
//                       pincode nobody actually checked.
const UNSERVICEABLE_REASON = {
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_PINCODE: 'INVALID_PINCODE',
  AREA_NOT_COVERED: 'AREA_NOT_COVERED',
  CHECK_UNAVAILABLE: 'CHECK_UNAVAILABLE',
};
exports.UNSERVICEABLE_REASON = UNSERVICEABLE_REASON;

/**
 * Check pincode serviceability. Called from the checkout/product page,
 * before an order even exists — and, via exports.checkDeliveryEligibility
 * below, as a server-side enforcement check right before an order is
 * actually placed.
 *
 * Never throws for a *business* answer about the pincode — an
 * unrecognized pincode comes back as a normal `{ serviceable: false,
 * reason }` result, not an error (Delhivery's pincode lookup itself never
 * errors for a well-formed-but-unknown pincode). It only throws (a 503)
 * when we genuinely couldn't get an answer at all — Delhivery timed out,
 * is down, or returned something unrecognized — so callers can tell "we
 * checked and the answer is no" apart from "we couldn't check".
 *
 * Returns the stable normalized shape every caller (frontend and backend
 * alike) can rely on:
 *   { serviceable, reason, estimatedDays, estimatedDeliveryDate, codAvailable }
 * — always exactly these keys, regardless of what Delhivery's raw response
 * happens to look like. Carrier-specific field names (cod, pre_paid, ...)
 * never escape this function.
 *
 * `estimatedDays`/`estimatedDeliveryDate` are always null here — unlike
 * the earlier, unverified Ekart assumption, Delhivery's pincode-lookup API
 * doesn't return an SLA day-count at all, so there's genuinely nothing to
 * estimate before a shipment exists. A real estimate only becomes
 * available once trackOrderShipment's first poll reports one (see
 * extractEstimatedDeliveryDate) — the frontend already renders a null
 * estimate as "not yet available" rather than a broken display.
 *
 * When `subtotal` is also passed, the response additionally carries the
 * delivery-charge / free-delivery side of the contract for that amount —
 * `deliveryCharge`, `freeDeliveryThreshold`, `freeDeliveryEligible` — so a
 * single call can answer serviceability *and* pricing together. Computed
 * via calculateDeliveryCharge from src/constants/pricing.js, the same
 * single source of truth order.service.js/cart.service.js use — never a
 * second copy of the rule. Omit `subtotal` and the response is exactly the
 * base shape above, unchanged.
 */
exports.checkServiceability = async ({ destinationPincode, subtotal }) => {
  // Cheapest, most common "not serviceable" case first — no Delhivery call
  // needed to know an empty string or "abc123" isn't a real pincode. See
  // UNSERVICEABLE_REASON.INVALID_FORMAT's docs above for why this can't
  // just rely on the route-level validator alone.
  if (!isValidIndianPincodeFormat(destinationPincode)) {
    return withPricing(
      {
        serviceable: false,
        reason: UNSERVICEABLE_REASON.INVALID_FORMAT,
        estimatedDays: null,
        estimatedDeliveryDate: null,
        codAvailable: false,
      },
      subtotal
    );
  }

  let response;
  try {
    response = await delhiveryClient.checkServiceability({
      destinationPincode,
    });
  } catch (error) {
    // A timeout, a network error, a Delhivery 5xx, or a 4xx — our (or
    // Delhivery's) infrastructure having a bad moment, not a real answer
    // about this pincode. Surfaced as a distinct 503 rather than a
    // generic 500, and deliberately not tagged with either
    // UNSERVICEABLE_REASON, so it's never confused with a definitive "no"
    // from Delhivery.
    throw new CustomError(
      'Could not check delivery availability right now. Please try again in a moment.',
      503
    );
  }

  return withPricing(
    {
      serviceable: response.serviceable,
      reason: response.serviceable
        ? null
        : UNSERVICEABLE_REASON.INVALID_PINCODE,
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: response.codAvailable,
    },
    subtotal
  );
};

/**
 * Non-throwing variant of checkServiceability, built for server-side
 * enforcement at order placement (see order.service.js's
 * detectAddressConflict — the actual gate that blocks COD confirmation /
 * Razorpay order creation for an unserviceable or invalid pincode).
 *
 * The distinction that matters here: a *definitive* negative answer
 * (not serviceable / invalid pincode) should always block the order. Our
 * own check failing to get an answer at all (Delhivery down, network blip,
 * a timeout) is different — that's our integration having a bad moment,
 * not evidence the address can't be delivered to — and what happens then
 * is governed by SHIPPING_SERVICEABILITY_FALLBACK_POLICY
 * (src/config/env.js), an explicit, ops-configurable policy rather than a
 * silent hardcoded choice:
 *
 *   'fail_open'   (default) — returns serviceable: true, so a carrier
 *                  hiccup never blocks checkout by itself. This is the
 *                  long-standing default behavior.
 *   'fail_closed' — returns serviceable: false with reason
 *                  CHECK_UNAVAILABLE, so an address whose deliverability
 *                  genuinely couldn't be confirmed is blocked from order
 *                  placement rather than let through on an assumption.
 *
 * Either way this never throws, never returns a bare "yes" that was
 * actually a guess, and always logs a warning so a carrier outage stays
 * visible in either mode.
 *
 * `paymentMode` is accepted (existing callers pass it) but no longer
 * forwarded to checkServiceability — Delhivery's pincode lookup doesn't
 * take a payment mode as input, unlike the earlier, unverified Ekart
 * assumption.
 */
exports.checkDeliveryEligibility = async ({
  destinationPincode,
  paymentMode,
}) => {
  void paymentMode;
  try {
    const result = await exports.checkServiceability({
      destinationPincode,
    });
    // `skippedCheck` is always present on the returned shape (even when we
    // got a definitive answer) — undefined here, `true` on the fallback
    // branches below — so callers can do a plain `if (eligibility.skippedCheck)`
    // check without also having to guard against the key being absent
    // entirely on the common (non-failure) path.
    return { ...result, skippedCheck: undefined };
  } catch (error) {
    const failClosed = shippingServiceabilityFallbackPolicy === 'fail_closed';
    logger.warn(
      `[shipping] Serviceability check failed during checkout enforcement for pincode ${destinationPincode} ` +
        `(policy: ${shippingServiceabilityFallbackPolicy}), ${failClosed ? 'blocking' : 'skipping'} enforcement: ${error.message}`
    );

    if (failClosed) {
      // Deliberately NOT tagged AREA_NOT_COVERED — that reason means "we
      // got a definitive answer and it was no". This means "we never got
      // an answer", which reads (and should be worded) very differently
      // to a customer than "we don't deliver here".
      return {
        serviceable: false,
        reason: UNSERVICEABLE_REASON.CHECK_UNAVAILABLE,
        estimatedDays: null,
        estimatedDeliveryDate: null,
        codAvailable: false,
        skippedCheck: true,
      };
    }

    // Same normalized shape checkServiceability itself returns (see its
    // docs) — estimatedDays/estimatedDeliveryDate included as null rather
    // than omitted, so a caller destructuring this result never has to
    // special-case "the fallback branch has fewer keys than everything
    // else". There's genuinely nothing to estimate here — the check never
    // got an answer — so null is the honest value, not a missing key.
    return {
      serviceable: true,
      reason: null,
      estimatedDays: null,
      estimatedDeliveryDate: null,
      codAvailable: true,
      skippedCheck: true,
    };
  }
};

/**
 * Create a shipment with Delhivery for a confirmed order, and persist the
 * resulting waybill (AWB) against it. Idempotent — calling this again for
 * an order that already has a shipment just returns the existing one, the
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

  const existingShipment = await prisma.shipment.findUnique({
    where: { orderId },
  });
  if (existingShipment) {
    return { shipment: existingShipment, alreadyProcessed: true };
  }

  const paymentMode = order.paymentStatus === 'cod_pending' ? 'COD' : 'PREPAID';
  const codAmount = paymentMode === 'COD' ? order.total : 0;

  const totalWeightKg = order.orderItems.reduce(
    (sum, item) =>
      sum + (item.product?.weightKg || DEFAULT_ITEM_WEIGHT_KG) * item.quantity,
    0
  );
  const totalQuantity = order.orderItems.reduce(
    (sum, item) => sum + item.quantity,
    0
  );
  // Delhivery's create-shipment payload takes one products_desc string for
  // the whole package (labeling/customs use, not itemized line items the
  // way the earlier, unverified Ekart assumption had) — a comma-joined
  // list of what's inside, capped so an unusually large cart doesn't
  // produce an unreasonably long label description.
  const productsDesc = order.orderItems
    .map((item) => item.product?.name)
    .filter(Boolean)
    .join(', ')
    .slice(0, 500);

  // `area` postdates some existing addresses (schema-optional — see
  // prisma/schema.prisma), so it's appended only when present rather than
  // assumed to always be there.
  const consigneeAddress = order.address.area
    ? `${order.address.houseArea}, ${order.address.area}`
    : order.address.houseArea;

  let delhiveryResponse;
  try {
    delhiveryResponse = await delhiveryClient.createShipment({
      order_id: order.id,
      payment_mode: paymentMode,
      cod_amount: codAmount,
      pickup_location_name: DELHIVERY_PICKUP_LOCATION_NAME,
      seller_name: DELHIVERY_SELLER_NAME,
      consignee: {
        name: order.address.name,
        phone: order.address.phone,
        address: consigneeAddress,
        city: order.address.city,
        state: order.address.state,
        pincode: order.address.pincode,
      },
      products_desc: productsDesc || 'General merchandise',
      quantity: totalQuantity,
      total_amount: order.total,
      weight_kg: totalWeightKg,
    });
  } catch (error) {
    // The order was confirmed (and, for COD, its stock reserved) already —
    // this can still fail here if the address's pincode has since drifted
    // out of Delhivery's coverage between confirmation and this manual
    // shipment-creation step (order.service.js's detectAddressConflict only
    // checks at confirmation time, not continuously). Surfaced as a clean
    // 422 naming the actual cause rather than a raw 500 with Delhivery's
    // internal error text, so an admin retrying this knows to fix the
    // address (or that Delhivery itself is unavailable) rather than
    // guessing.
    if (error.statusCode === 422) {
      throw new CustomError(
        `Could not create shipment — Delhivery no longer services this address's pincode (${order.address.pincode}).`,
        422
      );
    }
    throw new CustomError(
      'Could not create shipment with Delhivery right now. Please try again in a moment.',
      error.isTimeout ? 503 : error.statusCode >= 500 ? 503 : 502
    );
  }

  const createdPackage = delhiveryResponse?.packages?.[0];
  if (!delhiveryResponse?.success || createdPackage?.status !== 'Success') {
    throw new CustomError(
      `Could not create shipment with Delhivery: ${createdPackage?.remarks?.join?.(', ') || 'unknown error'}`,
      422
    );
  }

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      trackingId: createdPackage.waybill,
      awbNumber: createdPackage.waybill,
      // Set explicitly rather than relying on the Prisma schema's
      // @default("Delhivery") — confirmed live that the schema default
      // alone silently doesn't take effect until `prisma generate` is
      // re-run (a plain `prisma db push --skip-generate`, as this app's
      // own e2e:db:push script uses, does NOT regenerate the client), so
      // a real shipment was created with courierPartner still reading
      // "Ekart" despite the schema already saying "Delhivery".
      courierPartner: 'Delhivery',
      status: 'CREATED',
      paymentMode,
      codAmount,
      pickupLocationCode: DELHIVERY_PICKUP_LOCATION_NAME,
      estimatedDeliveryDate: null,
      raw: delhiveryResponse,
    },
  });

  // Reflect progress on the order itself too, so existing order views that
  // don't know about the Shipment model still show something meaningful.
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'shipped' },
  });

  return { shipment, alreadyProcessed: false };
};

/**
 * Fetch the latest status for an order's shipment, polling Delhivery and
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
    // Shipment record exists but Delhivery hasn't returned a waybill yet —
    // nothing to poll for.
    return shipment;
  }

  if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
    // Already final — see TERMINAL_SHIPMENT_STATUSES' own comment on why
    // this must never poll and overwrite a terminal record.
    return shipment;
  }

  const tracking = await delhiveryClient.trackShipment(shipment.trackingId);
  // Delhivery nests the actual shipment status under
  // ShipmentData[0].Shipment — see DelhiveryClient.trackShipment /
  // mapDelhiveryStatus's own header note on confidence level.
  const trackedShipment = tracking?.ShipmentData?.[0]?.Shipment;
  const status = mapDelhiveryStatus(trackedShipment?.Status?.Status);
  // A later poll can carry a revised ETA (e.g. after a delay in transit) —
  // only overwrite the stored estimate when this poll actually gave us
  // something to update it with, so a tracking payload that's silent on
  // timing (most in-transit pings) doesn't wipe out the estimate that was
  // set at shipment-creation time.
  const updatedEstimate = extractEstimatedDeliveryDate(trackedShipment);

  const updated = await prisma.shipment.update({
    where: { orderId },
    data: {
      status,
      lastLocation:
        trackedShipment?.Status?.StatusLocation ?? shipment.lastLocation,
      estimatedDeliveryDate: updatedEstimate ?? shipment.estimatedDeliveryDate,
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

  if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
    throw new CustomError(
      `Cannot cancel a shipment that is already '${shipment.status}'`,
      400
    );
  }

  // reason isn't sent to Delhivery — its edit/cancel endpoint's payload
  // has no cancellation-reason field, unlike the earlier, unverified
  // Ekart assumption. Kept as a param (and still recorded nowhere yet —
  // same as before) since it's part of this function's existing public
  // contract, used only for the log line below.
  if (shipment.trackingId) {
    // { status: true/false, remark } — a false status (confirmed live:
    // e.g. cancelling an already-cancelled shipment, or one Delhivery
    // otherwise won't let go of) is Delhivery declining the cancellation,
    // not a network/API error — must not be treated as success, or our
    // own record would claim CANCELLED while the real shipment (and any
    // physical pickup) is still active.
    const result = await delhiveryClient.cancelShipment(shipment.trackingId);
    if (!result?.status) {
      throw new CustomError(
        `Delhivery declined to cancel this shipment: ${result?.remark || 'unknown reason'}`,
        422
      );
    }
    logger.info(
      `[shipping] Cancelled Delhivery shipment ${shipment.trackingId} for order ${orderId}: ${reason || 'Customer requested cancellation'}`
    );
  }

  const updated = await prisma.shipment.update({
    where: { orderId },
    data: { status: 'CANCELLED' },
  });
  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'cancelled' },
  });

  return updated;
};

/**
 * Apply a verified Delhivery webhook event to our shipment + order
 * records. Same reconciliation role as payment.service.js's
 * handleRazorpayWebhookEvent: runs independently of whether/when the
 * client polls /track, and is safe to receive more than once for the
 * same event.
 *
 * Delhivery doesn't publish one universal webhook payload spec the way
 * Razorpay does (see DelhiveryClient.verifyWebhookSignature's note) — this
 * assumes the payload carries the same nested Shipment/Status shape as the
 * tracking API's response (a reasonable assumption for a status-push
 * webhook from the same provider), falling back to a bare top-level shape
 * if not. Confirm against the real payload once webhooks are configured
 * for this account; shipment status stays accurate via polling either way.
 */
exports.handleDelhiveryWebhookEvent = async (payload) => {
  const trackedShipment = payload?.Shipment ?? payload;
  const trackingId = trackedShipment?.AWB;
  if (!trackingId) {
    // Nothing to reconcile against — ack and ignore.
    return;
  }

  const shipment = await prisma.shipment.findUnique({ where: { trackingId } });
  if (!shipment) {
    logger.warn(
      `[shipping] Webhook received for unknown waybill: ${trackingId}`
    );
    return;
  }

  if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
    // Already final — see TERMINAL_SHIPMENT_STATUSES' own comment. A
    // late-arriving or out-of-order webhook must not revive a terminal
    // record either.
    return;
  }

  const status = mapDelhiveryStatus(trackedShipment?.Status?.Status);
  const updatedEstimate = extractEstimatedDeliveryDate(trackedShipment);

  await prisma.shipment.update({
    where: { trackingId },
    data: {
      status,
      lastLocation:
        trackedShipment?.Status?.StatusLocation ?? shipment.lastLocation,
      estimatedDeliveryDate: updatedEstimate ?? shipment.estimatedDeliveryDate,
      lastSyncedAt: new Date(),
      raw: payload,
    },
  });

  await syncOrderStatusFromShipment(shipment.orderId, status);
};
