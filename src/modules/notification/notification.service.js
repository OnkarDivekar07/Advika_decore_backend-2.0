// src/modules/notification/notification.service.js
//
// Order-confirmation SMS via MSG91's Flow API — a different endpoint from
// otp.service.js's OTP-specific one, since transactional (non-OTP) SMS in
// India needs its own DLT-registered template, not the OTP template.
//
// Deliberately never throws: this is called from a background job (see
// jobs/workers/notificationWorker.js) strictly *after* an order is already
// confirmed — a failed or unconfigured SMS send must never look like a
// reason to retry/rollback anything about the order itself. Every failure
// mode here resolves to a logged, structured { sent: false, reason } so
// it's visible in ops without ever bubbling up as an unhandled rejection.
const logger = require('@config/logger');

const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow/';

/**
 * @param {{ phone: string, orderId: string, total: number, paymentMethod: 'cod'|'online' }} args
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
exports.sendOrderConfirmationSms = async ({
  phone,
  orderId,
  total,
  paymentMethod,
}) => {
  const authKey = process.env.MSG91_AUTH_KEY;
  const flowId = process.env.MSG91_ORDER_CONFIRMATION_FLOW_ID;

  // No DLT-registered flow configured yet — skip quietly rather than
  // erroring the job. Same "optional, no-op until set up" shape as
  // Sentry in @config/sentry, so local/dev/CI never need this configured
  // for orders to work end-to-end.
  if (!authKey || !flowId) {
    logger.warn(
      `Order confirmation SMS skipped for order ${orderId} — MSG91_ORDER_CONFIRMATION_FLOW_ID not configured`
    );
    return { sent: false, reason: 'not_configured' };
  }

  if (!phone) {
    logger.warn(
      `Order confirmation SMS skipped for order ${orderId} — no phone on file`
    );
    return { sent: false, reason: 'no_phone' };
  }

  const mobile = `91${phone}`;
  const paymentLabel =
    paymentMethod === 'cod' ? 'Cash on Delivery' : 'Paid online';

  let response;
  try {
    response = await fetch(MSG91_FLOW_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: authKey,
      },
      // MSG91 Flow API shape: a template ("flow") with named variables
      // filled in per-recipient. Variable names here (ORDER_ID, AMOUNT,
      // PAYMENT_METHOD) must match whatever the DLT-registered template
      // for MSG91_ORDER_CONFIRMATION_FLOW_ID actually declares.
      body: JSON.stringify({
        flow_id: flowId,
        recipients: [
          {
            mobiles: mobile,
            ORDER_ID: orderId,
            AMOUNT: total.toFixed(2),
            PAYMENT_METHOD: paymentLabel,
          },
        ],
      }),
    });
  } catch (error) {
    logger.error(
      `MSG91 order-confirmation SMS unreachable for order ${orderId}: ${error.message}`
    );
    return { sent: false, reason: 'network_error' };
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok || data.type === 'error') {
    logger.error(
      `MSG91 order-confirmation SMS failed for order ${orderId}: ${data.message || data.error || text}`
    );
    return { sent: false, reason: 'msg91_error' };
  }

  logger.info(`Order confirmation SMS sent for order ${orderId}`);
  return { sent: true };
};
