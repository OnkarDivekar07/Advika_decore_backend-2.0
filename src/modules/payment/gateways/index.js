const razorpayGateway = require('./razorpay.gateway');
const { assertImplementsContract } = require('./paymentGateway.contract');

// Every adapter that exists gets registered here under a short id. Adding a
// second provider means writing ./<provider>.gateway.js against the
// contract in ./paymentGateway.contract.js and adding one line below — not
// touching payment.service.js or payment.controller.js, which only ever see
// whatever this file exports.
const GATEWAYS = {
  razorpay: razorpayGateway,
};

// Defaults to 'razorpay' since that's the only integration wired up today
// (and the only value this has ever needed to be) — PAYMENT_GATEWAY exists
// so a future second adapter can be switched to the same way, without
// another code change here.
const selected = process.env.PAYMENT_GATEWAY || 'razorpay';
const gateway = GATEWAYS[selected];

if (!gateway) {
  throw new Error(
    `Unknown PAYMENT_GATEWAY "${selected}". Available: ${Object.keys(GATEWAYS).join(', ')}`
  );
}

// Fail fast at require-time (app boot), not on the first request that
// happens to hit a method a half-finished adapter never implemented.
assertImplementsContract(gateway);

module.exports = gateway;
