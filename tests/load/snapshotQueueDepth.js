// tests/load/snapshotQueueDepth.js
//
// Pattern 23 (realistic load and concurrency test) — one-shot snapshot of
// every BullMQ queue's job counts, for a before/after comparison around
// each load profile (does a burst of transactional traffic leave a
// backlog, or does it drain?). Run via:
//   node scripts/run-with-e2e-env.js node tests/load/snapshotQueueDepth.js
require('module-alias/register');
// No @jobs module alias exists (see package.json's _moduleAliases) — plain
// relative paths from tests/load/ to src/jobs/queues/.
const clearCartQueue = require('../../src/jobs/queues/clearCartQueue');
const notificationQueue = require('../../src/jobs/queues/notificationQueue');
const imageQueue = require('../../src/jobs/queues/imageQueue');
const paymentReconciliationQueue = require('../../src/jobs/queues/paymentReconciliationQueue');
const refundReconciliationQueue = require('../../src/jobs/queues/refundReconciliationQueue');
const fulfillmentReconciliationQueue = require('../../src/jobs/queues/fulfillmentReconciliationQueue');

const queues = {
  'clear-cart-queue': clearCartQueue,
  'notification-queue': notificationQueue,
  'image-processing-queue': imageQueue,
  'payment-reconciliation-queue': paymentReconciliationQueue,
  'refund-reconciliation-queue': refundReconciliationQueue,
  'fulfillment-reconciliation-queue': fulfillmentReconciliationQueue,
};

async function main() {
  console.log(`Queue depth snapshot @ ${new Date().toISOString()}`);
  for (const [name, queue] of Object.entries(queues)) {
    // eslint-disable-next-line no-await-in-loop
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    console.log(`  ${name}: ${JSON.stringify(counts)}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('snapshotQueueDepth crashed:', err);
  process.exit(1);
});
