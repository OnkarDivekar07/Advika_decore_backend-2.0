// src/modules/admin/admin.analytics.service.js
//
// PHASE 11 — Business Analytics & Financial Overview.
//
// Everything here is additive to admin.service.js's existing getAdminStats
// (an all-time, unfiltered snapshot — left completely untouched). This file
// exists for the one thing that endpoint deliberately doesn't do:
// date-range-scoped KPIs and a chartable revenue trend, both computed on
// the backend so the admin panel never sums/derives a financial number in
// React.
//
// Hard rule enforced throughout this file: no profit, margin, or inventory
// valuation figure is ever computed or returned. Product has no cost-basis
// field in prisma/schema.prisma (only `price`, the sale price) — there is
// nothing to subtract from revenue to get a real profit number, and
// fabricating one from price alone would just be wrong. Every revenue
// figure here is explicitly gross revenue (money collected on paid orders),
// never "profit". See `KPI_DEFINITIONS` below, which is shipped to the
// frontend alongside the numbers so a definition never has to be
// hand-copied/kept in sync in React.
const prisma = require('@config/prisma');

// Mirrors order.service.js's own ORDER_LIST_STATUSES/PAYMENT_STATUSES
// duplication reasoning: this module's only dependency stays @config/prisma,
// so a unit test never needs to know order.validation.js exists. Caller
// (admin.validation.js) has already rejected anything outside these lists
// before a request ever reaches here; re-checked below anyway so a direct
// call with a bogus value can't leak into a Prisma `where`.
const DELIVERED_STATUS = 'delivered';
const PENDING_STATUS = 'pending';
const PAID_PAYMENT_STATUS = 'paid';
const CUSTOMER_ROLE = 'customer';

const GRANULARITIES = ['day', 'week', 'month'];
const DEFAULT_GRANULARITY = 'day';

// Revenue-trend has no meaningful "show everything" default the way
// overview does (an unbounded daily aggregation over a store's entire
// history is both a slow query and an unreadable chart) — 30 days is a
// sane default window for "what's revenue looked like recently", and is
// always echoed back in the response's `range` so the panel can label the
// chart accurately instead of assuming.
const DEFAULT_TREND_WINDOW_DAYS = 30;

/**
 * Every KPI this module can return, in plain English, describing exactly
 * what backend query produces it. Shipped back to the frontend inside each
 * response (see getAnalyticsOverview/getRevenueTrend below) rather than
 * hardcoded in the admin panel, so the displayed explanation can never
 * drift from what the number actually is.
 */
const KPI_DEFINITIONS = Object.freeze({
  grossRevenue:
    'Sum of Order.total across orders with paymentStatus="paid" and createdAt within the selected range. ' +
    'This is gross revenue collected via completed payments — not profit. The catalog has no recorded product ' +
    'cost, so no profit, margin, or inventory-valuation figure is calculated anywhere in this panel.',
  paidOrderCount:
    'Count of orders with paymentStatus="paid" and createdAt within the selected range. The same order set ' +
    'grossRevenue is summed over, so paidOrderCount and grossRevenue always reconcile against each other.',
  averageOrderValue:
    'grossRevenue ÷ paidOrderCount for the selected range, computed on the backend. Reported as 0 (not a ' +
    'divide-by-zero error) when there are no paid orders in range.',
  orderCount:
    'Count of all placed orders (every status except the in-progress "draft" cart state — see ' +
    "order.service.js's getAllOrders for why drafts are excluded everywhere in the admin panel) with " +
    'createdAt within the selected range, regardless of status or payment outcome.',
  deliveredOrders:
    'Count of orders with status="delivered" and createdAt within the selected range.',
  pendingOrders:
    'Count of orders with status="pending" and createdAt within the selected range.',
  newCustomers:
    'Count of users with role="customer" whose account createdAt falls within the selected range.',
  totalActiveProducts:
    'Count of products with isDeleted=false in the catalog right now. This is a live catalog snapshot — ' +
    'unlike the other fields on this endpoint it is NOT scoped to the selected date range, because a product ' +
    'listing has no "sold in this range" concept without conflating it with order data. Shown for context only.',
});

const TREND_DEFINITIONS = Object.freeze({
  revenue:
    'Sum of Order.total for paid orders (paymentStatus="paid") whose createdAt falls in this bucket. Same ' +
    "definition as the overview endpoint's grossRevenue, just broken out per period — summing every bucket's " +
    "revenue for a given range always reconciles with that range's grossRevenue from GET /analytics/overview.",
  orderCount: 'Count of paid orders whose createdAt falls in this bucket.',
});

/**
 * Parses an optional dateFrom/dateTo pair the same way order.service.js's
 * getAllOrders does: `dateTo` is treated as inclusive of the entire
 * calendar day the caller meant (23:59:59.999), not the literal midnight
 * instant `new Date(dateTo)` would parse to. Duplicated rather than
 * imported for the same zero-cross-module-dependency reason as the status
 * constants above.
 *
 * @param {string|undefined} dateFrom
 * @param {string|undefined} dateTo
 * @returns {{ from: Date|null, to: Date|null }}
 */
function resolveDateRange(dateFrom, dateTo) {
  let from = null;
  let to = null;

  if (dateFrom) {
    const parsed = new Date(dateFrom);
    if (!Number.isNaN(parsed.getTime())) from = parsed;
  }

  if (dateTo) {
    const parsed = new Date(dateTo);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setHours(23, 59, 59, 999);
      to = parsed;
    }
  }

  return { from, to };
}

/**
 * Builds a Prisma `createdAt` where-clause fragment from a resolved range.
 * Returns `undefined` (rather than `{}`) when both bounds are absent, so
 * spreading it into a `where` never adds a stray empty `createdAt: {}` key.
 */
function createdAtWhere({ from, to }) {
  if (!from && !to) return undefined;
  const clause = {};
  if (from) clause.gte = from;
  if (to) clause.lte = to;
  return clause;
}

/**
 * GET /api/admin/analytics/overview — date-range-scoped KPI summary. See
 * admin.service.js's getAdminStats for the unfiltered, all-time equivalent
 * this deliberately doesn't replace.
 *
 * @param {{ dateFrom?: string, dateTo?: string }} params
 */
exports.getAnalyticsOverview = async ({ dateFrom, dateTo } = {}) => {
  const range = resolveDateRange(dateFrom, dateTo);
  const createdAt = createdAtWhere(range);

  const [
    grossRevenueResult,
    paidOrderCount,
    orderCount,
    deliveredOrders,
    pendingOrders,
    newCustomers,
    totalActiveProducts,
  ] = await Promise.all([
    prisma.order.aggregate({
      where: {
        paymentStatus: PAID_PAYMENT_STATUS,
        ...(createdAt ? { createdAt } : {}),
      },
      _sum: { total: true },
    }),
    prisma.order.count({
      where: {
        paymentStatus: PAID_PAYMENT_STATUS,
        ...(createdAt ? { createdAt } : {}),
      },
    }),
    // Every real order excludes 'draft', same convention as
    // order.service.js's getAllOrders (drafts are in-progress carts, not
    // placed orders — never counted anywhere in the admin panel).
    prisma.order.count({
      where: {
        status: { not: 'draft' },
        ...(createdAt ? { createdAt } : {}),
      },
    }),
    prisma.order.count({
      where: {
        status: DELIVERED_STATUS,
        ...(createdAt ? { createdAt } : {}),
      },
    }),
    prisma.order.count({
      where: {
        status: PENDING_STATUS,
        ...(createdAt ? { createdAt } : {}),
      },
    }),
    prisma.user.count({
      where: {
        role: CUSTOMER_ROLE,
        ...(createdAt ? { createdAt } : {}),
      },
    }),
    // Deliberately NOT date-scoped — see totalActiveProducts's definition
    // in KPI_DEFINITIONS above.
    prisma.product.count({ where: { isDeleted: false } }),
  ]);

  const grossRevenue = grossRevenueResult._sum.total || 0;
  const averageOrderValue =
    paidOrderCount > 0 ? grossRevenue / paidOrderCount : 0;

  return {
    range: {
      from: range.from ? range.from.toISOString() : null,
      to: range.to ? range.to.toISOString() : null,
    },
    grossRevenue,
    paidOrderCount,
    averageOrderValue,
    orderCount,
    deliveredOrders,
    pendingOrders,
    newCustomers,
    totalActiveProducts,
    definitions: KPI_DEFINITIONS,
  };
};

/**
 * Pulls an ISO date string out of whatever shape `$runCommandRaw` handed
 * back for a Date value. Prisma's Mongo raw-command path serializes
 * dates as MongoDB Extended JSON (`{ $date: '...' }` or `{ $date: { $numberLong: '...' } }`)
 * rather than handing back a native JS Date the way the normal query API
 * does — this normalizes either shape (plus a plain Date/ISO-string,
 * belt-and-braces) into one ISO string so the trend response's
 * periodStart/periodEnd are always a predictable type for the frontend.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  if (typeof value === 'object' && '$date' in value) {
    const raw = value.$date;
    if (typeof raw === 'string') return new Date(raw).toISOString();
    if (raw && typeof raw === 'object' && '$numberLong' in raw) {
      return new Date(Number(raw.$numberLong)).toISOString();
    }
  }
  return null;
}

/**
 * Builds the `$group._id` expression for a given bucket granularity. `day`
 * and `month` group on a formatted UTC calendar-date string; `week` groups
 * on ISO week-year/week-number (Monday-start, per the ISO 8601 definition
 * MongoDB's $isoWeek/$isoWeekYear implement) since a plain string format
 * for week numbers isn't universally supported across MongoDB versions the
 * way $dateToString's day/month formats are.
 *
 * Bucket boundaries are UTC calendar periods — a deliberate, documented
 * choice so bucketing is deterministic regardless of the server process's
 * local timezone, independent of how the overall dateFrom/dateTo range
 * bound itself is interpreted (see resolveDateRange, which mirrors
 * order.service.js's existing local-time convention for that part).
 */
function buildGroupId(granularity) {
  if (granularity === 'month') {
    return {
      $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' },
    };
  }
  if (granularity === 'week') {
    return {
      isoYear: { $isoWeekYear: '$createdAt' },
      isoWeek: { $isoWeek: '$createdAt' },
    };
  }
  return {
    $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' },
  };
}

/**
 * Turns a bucket's raw `_id` (either a formatted date string, for
 * day/month, or an { isoYear, isoWeek } object, for week — see
 * buildGroupId) into a stable, human-readable label for chart axes.
 */
function labelForBucket(id, granularity) {
  if (granularity === 'week' && id && typeof id === 'object') {
    return `${id.isoYear}-W${String(id.isoWeek).padStart(2, '0')}`;
  }
  return String(id);
}

/**
 * GET /api/admin/analytics/revenue-trend — a chartable, backend-aggregated
 * time series of paid-order revenue and order count, bucketed by
 * day/week/month. Aggregation happens inside MongoDB via
 * `$runCommandRaw`'s aggregate pipeline (not by pulling every order row
 * into Node and bucketing in JS), so this stays cheap regardless of how
 * many orders exist in the selected range — the point of "aggregation on
 * the backend" for a dataset that's expected to grow.
 *
 * @param {{ dateFrom?: string, dateTo?: string, granularity?: 'day'|'week'|'month' }} params
 */
exports.getRevenueTrend = async ({ dateFrom, dateTo, granularity } = {}) => {
  const safeGranularity = GRANULARITIES.includes(granularity)
    ? granularity
    : DEFAULT_GRANULARITY;

  const range = resolveDateRange(dateFrom, dateTo);
  // Unlike overview, a totally unbounded trend query would aggregate the
  // store's entire order history — defaults to a trailing 30-day window
  // (from "now", inclusive of today) so the default chart is both fast and
  // actually readable. Always echoed back in `range` so the panel never has
  // to guess what window it's looking at.
  if (!range.from && !range.to) {
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    const from = new Date(to);
    from.setDate(from.getDate() - (DEFAULT_TREND_WINDOW_DAYS - 1));
    from.setHours(0, 0, 0, 0);
    range.from = from;
    range.to = to;
  } else if (range.from && !range.to) {
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    range.to = to;
  } else if (!range.from && range.to) {
    const from = new Date(range.to);
    from.setDate(from.getDate() - (DEFAULT_TREND_WINDOW_DAYS - 1));
    from.setHours(0, 0, 0, 0);
    range.from = from;
  }

  const pipeline = [
    {
      $match: {
        paymentStatus: PAID_PAYMENT_STATUS,
        createdAt: { $gte: range.from, $lte: range.to },
      },
    },
    {
      $group: {
        _id: buildGroupId(safeGranularity),
        revenue: { $sum: '$total' },
        orderCount: { $sum: 1 },
        periodStart: { $min: '$createdAt' },
        periodEnd: { $max: '$createdAt' },
      },
    },
    { $sort: { periodStart: 1 } },
  ];

  const result = await prisma.$runCommandRaw({
    aggregate: 'Order',
    pipeline,
    cursor: {},
  });

  const rawBuckets = result?.cursor?.firstBatch || [];

  const buckets = rawBuckets.map((bucket) => ({
    label: labelForBucket(bucket._id, safeGranularity),
    periodStart: toIsoString(bucket.periodStart),
    periodEnd: toIsoString(bucket.periodEnd),
    // Every value straight off the aggregation pipeline — nothing here is
    // ever interpolated, estimated, or backfilled for a missing period, so
    // a chart built from this array only ever plots periods that had at
    // least one paid order. Charts must never fabricate zero-filled gaps
    // as if they were real data points; if a frontend wants explicit
    // zero-value gaps for calendar continuity it should insert them
    // itself, clearly, from this authoritative sparse series.
    revenue: typeof bucket.revenue === 'number' ? bucket.revenue : 0,
    orderCount: typeof bucket.orderCount === 'number' ? bucket.orderCount : 0,
  }));

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    granularity: safeGranularity,
    buckets,
    definitions: TREND_DEFINITIONS,
  };
};
