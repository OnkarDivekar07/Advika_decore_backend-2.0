// src/constants/payment.js
//
// Shared payment-lifecycle constants. Currently just the staleness window
// reconcileStalePaymentAttempts (payment.service.js) uses to decide a
// pending/attempted/processing payment attempt has gone stale and should be
// marked 'timeout' — pulled from env (see src/config/env.js) rather than
// hardcoded here, same reasoning as src/constants/pricing.js's delivery
// charge: ops can tune it without a code change.
const env = require('@config/env');

const PAYMENT_ATTEMPT_TIMEOUT_MS = env.paymentAttemptTimeoutMinutes * 60 * 1000;

// States a payment attempt can be reconciled *away from* once it's gone
// stale or been explicitly abandoned — i.e. everything that isn't already a
// terminal outcome (paid/failed/cancelled/timeout/unknown/refunded) or COD's
// own separate cod_pending state.
const RECONCILABLE_PAYMENT_STATUSES = ['pending', 'attempted', 'processing'];

// BUG FIX (see E2E_TEST_REPORT.md's Bug A / A2): Order.payment_order_id is
// `String? @unique` (prisma/schema.prisma). On MongoDB, a plain (non-sparse)
// unique index treats every document that has this field missing/null as
// sharing the exact same indexed "no value" — so leaving it null/absent for
// a fresh draft order breaks two separate ways, both reproduced directly
// against the real database:
//   1. Prisma's MongoDB query engine (this project's Prisma version) only
//      matches a `{ payment_order_id: null }` filter against documents
//      where the field is *explicitly* stored as BSON null — never against
//      documents where it's simply absent (which is what a bare
//      `tx.order.create({ data: {...} })` produces when the field is never
//      passed). That made createRazorpayOrder's optimistic-concurrency
//      update (`updateMany({ where: { payment_order_id: null }, ... })`)
//      match ZERO rows on the very first attempt, for every single order —
//      i.e. the entire online-payment path failed 100% of the time, not
//      just under concurrency.
//   2. Even storing an *explicit* null doesn't fix the deeper issue: MongoDB
//      still only allows ONE document total to hold that "no value" state
//      under a non-sparse unique index, so a second customer creating their
//      own fresh draft order while any other unpaid draft exists anywhere
//      in the database throws a raw, unhandled Prisma P2002.
//
// The fix: never leave payment_order_id null/absent at all. Every order
// gets its own per-order-unique placeholder the moment it's created
// (createDraftOrderService, order.service.js) — globally unique because
// it's derived from the order's own id, so it satisfies @unique naturally
// without ever needing MongoDB's null-handling. Everywhere the codebase
// used to ask "is payment_order_id null?" to mean "has this order ever
// started a real payment attempt?", it now asks isPendingPaymentOrderId(...)
// instead. The placeholder is stripped back to `null` before any order is
// serialized to a client response (see order.service.js's sanitizeOrder) —
// it's a purely internal representation, the public API contract is
// unchanged.
const PENDING_PAYMENT_ORDER_ID_PREFIX = 'draft-';
const makePendingPaymentOrderId = (orderId) =>
  `${PENDING_PAYMENT_ORDER_ID_PREFIX}${orderId}`;
const isPendingPaymentOrderId = (value) =>
  typeof value === 'string' && value.startsWith(PENDING_PAYMENT_ORDER_ID_PREFIX);

module.exports = {
  PAYMENT_ATTEMPT_TIMEOUT_MS,
  RECONCILABLE_PAYMENT_STATUSES,
  PENDING_PAYMENT_ORDER_ID_PREFIX,
  makePendingPaymentOrderId,
  isPendingPaymentOrderId,
};
