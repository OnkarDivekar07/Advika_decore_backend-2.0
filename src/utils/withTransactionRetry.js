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
// Deliberately narrow: only P2034 is ever retried. Every other error (a
// real CustomError, a validation failure, insufficient stock, etc.)
// rethrows immediately on the very first attempt, completely unchanged —
// this only ever changes behavior for the one error code it's named
// after.
const prisma = require('@config/prisma');

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;

const withTransactionRetry = async (callback, options) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.$transaction(callback, options);
    } catch (err) {
      if (err?.code !== 'P2034' || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
    }
  }
  // Unreachable (the loop always either returns or throws), but keeps the
  // function's own type honest for anything statically analyzing it.
  return undefined;
};

module.exports = withTransactionRetry;
