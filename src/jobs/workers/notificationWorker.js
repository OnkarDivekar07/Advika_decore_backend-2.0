// src/jobs/workers/notificationWorker.js
//
// Processes 'order-confirmation' jobs queued from payment.service.js
// (handleCODOrder, updateOrderAfterPayment, and the webhook's
// payment.captured branch — see the same `cartQueue.add('clear-cart', ...)`
// call sites, which this mirrors).
//
// Re-fetches the order fresh here rather than trusting whatever the caller
// had in memory at enqueue time — same "backend is truth, re-fetch, don't
// carry stale state across an async boundary" rule the rest of the
// checkout pipeline follows (checkout-architecture.md §2). This also means
// a job that sits in the queue for a while (Redis hiccup, worker restart)
// still reflects the order's real state by the time it actually runs.
const { Worker } = require('bullmq');
const connection = require('@config/redis');
const prisma = require('@config/prisma');
const logger = require('@config/logger');
const notificationService = require('@modules/notification/notification.service');

const notificationWorker = new Worker(
  'notification-queue',
  async (job) => {
    if (job.name !== 'order-confirmation') {
      throw new Error(`Unknown notification job: ${job.name}`);
    }

    const { orderId } = job.data;
    if (!orderId) throw new Error('Missing orderId');

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: { select: { phone: true } } },
    });

    if (!order) {
      logger.warn(
        `Order confirmation SMS skipped — order ${orderId} not found`
      );
      return { sent: false, reason: 'order_not_found' };
    }

    // Guards against a job outliving/racing whatever confirmed the order —
    // e.g. a webhook retry re-queuing after the order was already
    // reconciled and since cancelled some other way. Only ever notify for
    // an order that's actually confirmed right now, not whatever it was
    // when this job was enqueued.
    if (order.status !== 'confirmed') {
      logger.info(
        `Order confirmation SMS skipped — order ${orderId} is not confirmed (status: ${order.status})`
      );
      return { sent: false, reason: 'not_confirmed' };
    }

    return notificationService.sendOrderConfirmationSms({
      phone: order.user?.phone,
      orderId: order.id,
      total: order.total,
      paymentMethod: order.paymentStatus === 'cod_pending' ? 'cod' : 'online',
    });
  },
  { connection }
);

// Retry/backoff for this queue live on notificationQueue.js's
// `defaultJobOptions` now — see clearCartWorker.js's comment for why
// `settings.retryProcessDelay`/`attempts` never actually worked here.
// Safe to retry: notification.service.js's sendOrderConfirmationSms
// deliberately never throws (it resolves { sent: false, reason } on any
// failure), so a retry can only be triggered by the order lookup above
// it failing — never by re-sending an SMS that already went out.
notificationWorker.on('failed', (job, err) => {
  logger.error(`Notification job failed [${job.id}]: ${err.message}`, {
    stack: err.stack,
  });
});

notificationWorker.on('error', (err) => {
  logger.error(`Notification worker-level error: ${err.message}`, {
    stack: err.stack,
  });
});

module.exports = notificationWorker;
