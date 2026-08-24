const prisma = require('@config/prisma');
const logger = require('@config/logger');
const CustomError = require('@utils/customError');
const ekartClient = require('../../services/external/EkartClient');
const {
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_CHARGE,
  calculateDeliveryCharge,
} = require('@constants/pricing');
const { isValidIndianPincodeFormat } = require('@constants/pincode');
const { shippingServiceabilityFallbackPolicy } = require('@config/env');

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

// Turns a raw day-count SLA into a concrete calendar date, so the frontend
// never has to do its own "today + N days" arithmetic (and risk drifting
// from whatever timezone/business-day rules the backend eventually applies
// here — e.g. skipping Sundays — without a frontend change). Backend stays
// the single source of truth for what "estimated delivery" actually means;
// the frontend only ever displays what this returns.
function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + Number(days));
  return date;
}

// Ekart's raw response field name for an estimated/expected delivery date
// isn't confirmed yet (see the TODOs in EkartClient.js) — this tries the
// handful of plausible shapes a carrier API might use for an explicit date,
// and only falls back to deriving one from a day-count SLA if none of them
// are present. Centralized here (rather than duplicated at each call site)
// so a single spot needs updating once the real field name is confirmed
// against Ekart's docs.
function extractEstimatedDeliveryDate(ekartResponse) {
  const rawDate =
    ekartResponse?.estimated_delivery_date ??
    ekartResponse?.expected_delivery_date ??
    ekartResponse?.edd ??
    null;
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const days =
    ekartResponse?.estimated_delivery_days ?? ekartResponse?.sla_days ?? null;
  if (days != null && Number.isFinite(Number(days))) {
    return addDays(days);
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
//                        entirely locally, before ever calling Ekart —
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
//                        silently reaching Ekart or slipping through.
//   INVALID_PINCODE   — well-formed (passes the shape check above), but
//                       Ekart doesn't recognize it at all (isn't a real
//                       Indian PIN in their system — a typo, or a code
//                       that simply doesn't exist). E.g. "999999".
//   AREA_NOT_COVERED  — a real, recognized pincode that Ekart just doesn't
//                       deliver to (yet). The normal, expected shape of a
//                       "not serviceable" answer.
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

// Substrings an Ekart error response might use to say "this pincode isn't
// one we recognize" specifically, as opposed to "we recognize it but don't
// deliver there" — the latter normally comes back as a clean 200 with
// serviceable:false, not an error at all.
// TODO: confirm the real error code/message Ekart uses for an unrecognized
// pincode against their Serviceability API docs — this is a best-effort
// heuristic until then, deliberately conservative (falls through to the
// generic "check unavailable" path below rather than mis-tagging a
// legitimate outage as an invalid pincode) if nothing matches.
const INVALID_PINCODE_ERROR_HINTS = [
  'invalid pincode',
  'invalid postal code',
  'pincode not found',
  'unrecognized pincode',
  'invalid_pincode',
  'pincode_not_found',
];

function looksLikeInvalidPincodeError(error) {
  const haystack =
    `${error?.message || ''} ${error?.raw?.error_code || ''} ${error?.raw?.code || ''}`.toLowerCase();
  return INVALID_PINCODE_ERROR_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Check pincode serviceability + delivery estimate. Called from the
 * checkout/product page, before an order even exists — and, via
 * exports.checkDeliveryEligibility below, as a server-side enforcement
 * check right before an order is actually placed.
 *
 * Never throws for a *business* answer about the pincode — "not real" and
 * "real but uncovered" both come back as a normal `{ serviceable: false,
 * reason }` result. It only throws (a 503) when we genuinely couldn't get
 * an answer at all — Ekart timed out, is down, or returned something
 * unrecognized — so callers can tell "we checked and the answer is no"
 * apart from "we couldn't check".
 *
 * Returns the stable normalized shape every caller (frontend and backend
 * alike) can rely on:
 *   { serviceable, reason, estimatedDays, estimatedDeliveryDate, codAvailable }
 * — always exactly these keys, regardless of what Ekart's raw response
 * happens to look like (see mapEkartStatus/extractEstimatedDeliveryDate for
 * the same normalization pattern elsewhere in this file). Carrier-specific
 * field names (is_serviceable, sla_days, edd, ...) never escape this
 * function.
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
exports.checkServiceability = async ({
  destinationPincode,
  paymentMode = 'PREPAID',
  weightKg,
  subtotal,
}) => {
  // Cheapest, most common "not serviceable" case first — no Ekart call
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
    response = await ekartClient.checkServiceability({
      originPincode: EKART_PICKUP_PINCODE,
      destinationPincode,
      paymentMode,
      weightKg,
    });
  } catch (error) {
    if (
      !error.isTimeout &&
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      looksLikeInvalidPincodeError(error)
    ) {
      return withPricing(
        {
          serviceable: false,
          reason: UNSERVICEABLE_REASON.INVALID_PINCODE,
          estimatedDays: null,
          estimatedDeliveryDate: null,
          codAvailable: false,
        },
        subtotal
      );
    }

    // Anything else — a timeout, a network error, an Ekart 5xx, or a 4xx
    // that doesn't match the invalid-pincode heuristic above — is our (or
    // Ekart's) infrastructure having a bad moment, not a real answer about
    // this pincode. Surfaced as a distinct 503 rather than a generic 500,
    // and deliberately not tagged with either UNSERVICEABLE_REASON, so it's
    // never confused with a definitive "no" from Ekart.
    throw new CustomError(
      'Could not check delivery availability right now. Please try again in a moment.',
      503
    );
  }

  const serviceable = Boolean(
    response?.serviceable ?? response?.is_serviceable
  );
  const estimatedDays =
    response?.estimated_delivery_days ?? response?.sla_days ?? null;

  return withPricing(
    {
      serviceable,
      reason: serviceable ? null : UNSERVICEABLE_REASON.AREA_NOT_COVERED,
      estimatedDays,
      // Only meaningful when the pincode is actually serviceable — a
      // non-serviceable pincode has nothing to estimate a date against, so
      // this stays null rather than showing a date for a delivery that
      // can't happen. Computed here (not left for the frontend to derive
      // from estimatedDays) so the same day-count-to-date rule applies
      // everywhere — see extractEstimatedDeliveryDate/addDays above.
      estimatedDeliveryDate:
        serviceable && estimatedDays != null ? addDays(estimatedDays) : null,
      codAvailable: Boolean(response?.cod_available),
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
 * own check failing to get an answer at all (Ekart down, network blip, a
 * timeout) is different — that's our integration having a bad moment, not
 * evidence the address can't be delivered to — and what happens then is
 * governed by SHIPPING_SERVICEABILITY_FALLBACK_POLICY (src/config/env.js),
 * an explicit, ops-configurable policy rather than a silent hardcoded
 * choice:
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
 */
exports.checkDeliveryEligibility = async ({
  destinationPincode,
  paymentMode,
}) => {
  try {
    const result = await exports.checkServiceability({
      destinationPincode,
      paymentMode,
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

  // TODO: confirm this payload shape against Ekart's "Create Shipment" doc.
  let ekartResponse;
  try {
    ekartResponse = await ekartClient.createShipment({
      order_id: order.id,
      payment_mode: paymentMode,
      cod_amount: codAmount,
      pickup_location_code: EKART_PICKUP_LOCATION_CODE,
      consignee: {
        name: order.address.name,
        phone: order.address.phone,
        // `area` postdates some existing addresses (schema-optional — see
        // prisma/schema.prisma), so it's appended only when present rather
        // than assumed to always be there.
        address: order.address.area
          ? `${order.address.houseArea}, ${order.address.area}`
          : order.address.houseArea,
        landmark: order.address.landmark || undefined,
        city: order.address.city,
        state: order.address.state,
        pincode: order.address.pincode,
        instructions: order.address.deliveryInstructions || undefined,
      },
      items: order.orderItems.map((item) => ({
        sku: item.productId,
        name: item.product?.name,
        quantity: item.quantity,
        unit_price: item.price,
      })),
      weight: totalWeightKg,
    });
  } catch (error) {
    // The order was confirmed (and, for COD, its stock reserved) already —
    // this can still fail here if the address's pincode has since drifted
    // out of Ekart's coverage between confirmation and this manual
    // shipment-creation step (order.service.js's detectAddressConflict only
    // checks at confirmation time, not continuously). Surfaced as a clean
    // 422 naming the actual cause rather than a raw 500 with Ekart's
    // internal error text, so an admin retrying this knows to fix the
    // address (or that Ekart itself is unavailable) rather than guessing.
    if (looksLikeInvalidPincodeError(error) || error.statusCode === 422) {
      throw new CustomError(
        `Could not create shipment — Ekart no longer services this address's pincode (${order.address.pincode}).`,
        422
      );
    }
    throw new CustomError(
      'Could not create shipment with Ekart right now. Please try again in a moment.',
      error.isTimeout ? 503 : error.statusCode >= 500 ? 503 : 502
    );
  }

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      trackingId: ekartResponse?.tracking_id ?? ekartResponse?.awb_number,
      awbNumber: ekartResponse?.awb_number,
      status: 'CREATED',
      paymentMode,
      codAmount,
      pickupLocationCode: EKART_PICKUP_LOCATION_CODE,
      estimatedDeliveryDate: extractEstimatedDeliveryDate(ekartResponse),
      raw: ekartResponse,
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
  // A later poll can carry a revised ETA (e.g. after a delay in transit) —
  // only overwrite the stored estimate when this poll actually gave us
  // something to update it with, so a tracking payload that's silent on
  // timing (most in-transit pings) doesn't wipe out the estimate that was
  // set at shipment-creation time.
  const updatedEstimate = extractEstimatedDeliveryDate(tracking);

  const updated = await prisma.shipment.update({
    where: { orderId },
    data: {
      status,
      lastLocation: tracking?.current_location ?? shipment.lastLocation,
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

  if (['DELIVERED', 'RTO_DELIVERED', 'CANCELLED'].includes(shipment.status)) {
    throw new CustomError(
      `Cannot cancel a shipment that is already '${shipment.status}'`,
      400
    );
  }

  if (shipment.trackingId) {
    await ekartClient.cancelShipment(
      shipment.trackingId,
      reason || 'Customer requested cancellation'
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
    logger.warn(
      `[shipping] Webhook received for unknown tracking ID: ${trackingId}`
    );
    return;
  }

  const status = mapEkartStatus(payload?.status_code ?? payload?.status);
  const updatedEstimate = extractEstimatedDeliveryDate(payload);

  await prisma.shipment.update({
    where: { trackingId },
    data: {
      status,
      lastLocation: payload?.current_location ?? shipment.lastLocation,
      estimatedDeliveryDate: updatedEstimate ?? shipment.estimatedDeliveryDate,
      lastSyncedAt: new Date(),
      raw: payload,
    },
  });

  await syncOrderStatusFromShipment(shipment.orderId, status);
};
