// src/utils/withTransactionRetry.js
//
// MongoDB (via Prisma's $transaction) can reject a transaction with error
// code P2034 — "Transaction failed due to a write conflict or a deadlock.
// Please retry your transaction" — whenever two concurrent transactions
// genuinely touch the same data at the same moment. This is Prisma's own
// documented, EXPECTED behavior for MongoDB transactions, not a bug in
// the transaction itself: https://www.prisma.io/docs/orm/reference/error-reference#p2034
// The standard mitigation (per Prisma's own docs) is to catch this
// specific error and retry the whole transaction a few times — which is
// what every prisma.$transaction call in this app now goes through,
// instead of calling $transaction directly.
//
// Left uncaught, this surfaces as a raw, unhandled 500 whose message
// includes the exact server file path and line number that threw, via
// errorHandler.js's own (now-fixed) message pass-through — confirmed
// live: two genuinely concurrent checkout requests (two customers racing
// for stock, or the same customer's request landing twice) reproduced
// this on the very first real try, via the real E2E concurrency spec this
// fixes (frontend-improved/e2e-real/concurrency.spec.js).
//
// Deliberately narrow: only two specific, genuinely-transient failure
// shapes are ever retried. Every other error (a real CustomError, a
// validation failure, insufficient stock, etc.) rethrows immediately on
// the very first attempt, completely unchanged.
//
// Tuning history: originally 3 attempts / a flat 100ms*attempt backoff,
// validated against light contention (two concurrent buyers). A real
// concurrency load test (tests/e2e-helpers/loadTestConcurrency.js) run
// against 25 real concurrent buyers racing the same 5-stock product found
// this budget genuinely insufficient — most of the losing requests
// exhausted all 3 attempts and surfaced as raw 500s, not because of a data-
// integrity bug (stock never went negative, no duplicate orders were ever
// created) but because contention this high needs more room to resolve.
// The flat, deterministic backoff made it worse: every failed transaction
// retried at exactly the same offsets (100ms, 200ms), so a losing group
// tended to collide with each other again on the very next attempt instead
// of spreading out — a textbook thundering-herd amplifier. Raised the
// budget and added jitter to break that synchronization.
//
// A second real failure mode showed up when the same load test was pushed
// to 90 concurrent buyers on the same 5-stock product: requests weren't
// just losing individual write races anymore (P2034) — some queued for
// the underlying document lock long enough that Prisma's own 5-second
// interactive-transaction timeout expired before the transaction ever got
// its turn, surfacing as `PrismaClientKnownRequestError` code P2028
// ("Transaction API error: Transaction already closed: ... The timeout
// for this transaction was 5000 ms, however Nms passed..."). P2028 also
// covers unrelated, genuinely non-transient cases — a stale/invalid
// transaction reference, or code trying to use a transaction handle after
// it already committed — retrying those would be wrong (the second could
// even risk re-applying already-committed work), so this only retries the
// specific timeout-shaped P2028, matched on its own message text since
// Prisma gives the timeout case no code of its own to key on more
// precisely.
//
// A third tuning pass: the same load test pushed to 90 concurrent buyers
// on one 5-stock product found the 6-attempt/~60ms budget still cleared
// out too early — nearly all 90 losers exhausted every attempt within
// about the same 1-second window and gave up with only 1 of 5 real units
// actually sold, even though stock remained (confirmed via direct DB
// check — this is under-selling, not a correctness/oversell bug: stock
// never went negative and no duplicate orders were created). The atomic,
// conditional stock decrement itself (inventoryService.decrementStockForOrder)
// isn't the bottleneck — it's that handleCODOrder wraps it inside a wider,
// multi-step transaction (order fetch, conflict checks, decrement, status
// update, all-or-nothing), so 90 of those wider transactions colliding on
// the same product document need more retry room to actually drain
// through MongoDB's per-document write-conflict queue than a ~1s budget
// gives them. Raised the budget again rather than restructuring that
// transaction boundary — pulling the decrement out from under the
// transaction would need new compensating rollback logic for "stock
// decremented but the order write then failed," trading a proven
// all-or-nothing guarantee for raw throughput on what is a genuinely
// extreme, fully-correlated worst case (every buyer hitting the exact
// same single SKU in the same millisecond), not the shape real spike
// traffic takes.
//
// A fourth failure mode, found live (Pattern 10's concurrency audit —
// firing two genuinely simultaneous, identically-signed Razorpay webhook
// deliveries at handleRazorpayWebhookEvent): MongoDB can abort the LOSING
// side of a write conflict on one operation, but Prisma doesn't always
// surface that abort as P2034 at the operation that actually lost the
// race — sometimes the conflicted operation (here, the WebhookEvent
// ledger insert two deliveries both attempt) itself appears to succeed
// from the transaction's point of view, and the abort only actually
// throws on the *next* operation in the same transaction (here, the
// order.updateMany a few lines later), as `PrismaClientKnownRequestError`
// code P2028 with the message "Transaction API error: Transaction with
// { txnNumber: N } has been aborted." — not the "already closed"/expired-
// timeout wording the P2028 case above was written for, so it fell
// through as an unhandled 500 (confirmed live: one of two concurrent,
// identical webhook deliveries got exactly this error). Unlike the
// non-retryable P2028 cases (a stale/invalid transaction reference, or
// code reusing an already-committed handle — see the comment above),
// "has been aborted" specifically means MongoDB itself killed this
// transaction for a write conflict, which is exactly the transient,
// safe-to-retry condition P2034 exists to handle — it's just arriving via
// a different Prisma error code because of where in the transaction the
// conflict actually surfaced. Retrying re-runs the whole transaction from
// scratch, so the ledger insert gets a second, clean attempt against
// whatever the winner has since committed (correctly resolving to
// "duplicate delivery" via the ordinary P2002 path this time).
const prisma = require('@config/prisma');
const CustomError = require('./customError');

const MAX_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_JITTER_MS = 150;

const isTransactionTimeout = (err) =>
  err?.code === 'P2028' && /timeout|timed out/i.test(err?.message || '');

const isTransactionAborted = (err) =>
  err?.code === 'P2028' && /has been aborted/i.test(err?.message || '');

const isRetryable = (err) =>
  err?.code === 'P2034' || isTransactionTimeout(err) || isTransactionAborted(err);

const withTransactionRetry = async (callback, options) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.$transaction(callback, options);
    } catch (err) {
      if (!isRetryable(err)) {
        throw err;
      }
      if (attempt === MAX_ATTEMPTS) {
        // Every attempt hit real, sustained write contention on the same
        // document(s) — not a bug, but not something to hand back to the
        // client as an opaque 500 either. This is the one place every
        // $transaction call in the app funnels through, so converting the
        // final exhausted P2034 into the same kind of 409 the app already
        // uses for a stale-cart/stock conflict covers all of them at once:
        // the frontend already knows how to show this (any 409 is treated
        // as "please refresh and try again" — see cartService.js's
        // isCartConflictError), so nothing downstream needs to change.
        throw new CustomError(
          'This item is experiencing very high demand right now. Please try again in a moment.',
          409
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt + Math.random() * RETRY_JITTER_MS)
      );
    }
  }
  // Unreachable (the loop always either returns or throws), but keeps the
  // function's own type honest for anything statically analyzing it.
  return undefined;
};

module.exports = withTransactionRetry;
