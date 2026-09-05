// End-to-end tests for the full checkout journey:
//   add to cart -> create draft order -> pay (COD or Razorpay) -> confirmed
//
// Unlike the other integration tests in this folder (which mock a module's
// service layer), this suite mocks only the *outermost* boundaries — the
// Prisma client, the Razorpay SDK, and the BullMQ cart-clearing queue — and
// lets the real cart/order/payment/inventory routes, controllers, and
// services run against an in-memory fake database. That gives us real
// coverage of how those modules compose together for a full purchase,
// including the atomic stock guard when two shoppers race for the last item.

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// -- Razorpay SDK: never hit the network --------------------------------
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: jest.fn() },
    payments: { fetch: jest.fn() },
  }))
);

// -- Delhivery client: never hit the network ------------------------------
// Same "mock only the outermost boundary" rule this suite applies to
// Razorpay — checkout now also runs a real delivery-serviceability check
// (order.service.js's detectAddressConflict, via shipping.service.js) at
// both the COD and Razorpay-order-creation gates, so this needs a
// deterministic stand-in too rather than either hitting the real network
// or silently relying on the fail-open fallback path to paper over an
// unmocked dependency.
jest.mock('../../src/services/external/DelhiveryClient', () => ({
  checkServiceability: jest
    .fn()
    .mockResolvedValue({ serviceable: true, recognized: true, codAvailable: true, prepaidAvailable: true }),
  createShipment: jest.fn(),
  trackShipment: jest.fn(),
  cancelShipment: jest.fn(),
  updateShipment: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

// -- Authenticate: real JWT verification is unit-tested elsewhere; here we
// just need to attribute each request to a user/role, read off headers so
// a single suite can act as several different shoppers. --------------------
jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = {
      userId: req.headers['x-user-id'] || 'user_1',
      role: req.headers['x-role'] || 'customer',
    };
    next();
  })
);

// -- In-memory fake database standing in for Prisma ----------------------
let db;
let idCounter;

const genId = () => {
  idCounter += 1;
  return idCounter.toString(16).padStart(24, '0');
};

const resetDb = () => {
  idCounter = 0;
  db = {
    products: {}, // id -> { id, name, price, stock }
    addresses: {}, // id -> { id, userId }
    carts: [], // { id, userId, productId, quantity }
    orders: {}, // id -> { id, userId, total, addressId, status, paymentStatus, payment_order_id, payment_id, createdAt }
    orderItems: [], // { id, orderId, productId, quantity, price }
  };
};

const seedProduct = (overrides = {}) => {
  const id = genId();
  db.products[id] = {
    id,
    name: 'Trail Runner',
    price: 500,
    stock: 10,
    ...overrides,
    id,
  };
  return db.products[id];
};

const seedAddress = (userId) => {
  const id = genId();
  // A valid-format pincode is required as of the delivery-serviceability
  // check detectAddressConflict now runs before COD confirmation / Razorpay
  // order creation (see order.service.js) — an address without one would
  // fail that check for real (INVALID_FORMAT), not exercise the checkout
  // path this suite is actually testing.
  db.addresses[id] = { id, userId, pincode: '400001' };
  return db.addresses[id];
};

const mockPrisma = {
  cart: {
    findMany: jest.fn(async ({ where, include }) => {
      const items = db.carts.filter((c) => c.userId === where.userId);
      return items.map((c) => ({
        ...c,
        ...(include?.product ? { product: db.products[c.productId] } : {}),
      }));
    }),
    deleteMany: jest.fn(async ({ where }) => {
      const before = db.carts.length;
      if (where.id?.in) {
        const idsToDelete = new Set(where.id.in);
        db.carts = db.carts.filter((c) => !idsToDelete.has(c.id));
      } else {
        db.carts = db.carts.filter((c) => c.userId !== where.userId);
      }
      return { count: before - db.carts.length };
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = db.carts.find((c) => c.id === where.id);
      if (!row) throw new Error('Cart row not found');
      if (typeof data.quantity === 'number') row.quantity = data.quantity;
      return row;
    }),
    createMany: jest.fn(async ({ data }) => {
      data.forEach((d) => db.carts.push({ id: genId(), ...d }));
      return { count: data.length };
    }),
    upsert: jest.fn(async ({ where, update, create, include }) => {
      const { userId, productId } = where.userId_productId;
      const existing = db.carts.find(
        (c) => c.userId === userId && c.productId === productId
      );
      let row;
      if (existing) {
        Object.assign(existing, update);
        row = existing;
      } else {
        row = { id: genId(), ...create };
        db.carts.push(row);
      }
      return {
        ...row,
        ...(include?.product ? { product: db.products[row.productId] } : {}),
      };
    }),
  },
  address: {
    findUnique: jest.fn(async ({ where }) => db.addresses[where.id] || null),
  },
  order: {
    findFirst: jest.fn(async ({ where, orderBy, include }) => {
      let matches = Object.values(db.orders).filter(
        (o) =>
          o.userId === where.userId &&
          (!where.status || o.status === where.status)
      );
      if (orderBy?.createdAt === 'desc') {
        matches = matches.sort((a, b) => b.createdAt - a.createdAt);
      }
      const order = matches[0];
      if (!order) return null;

      const result = { ...order };
      if (include?.orderItems) {
        let items = db.orderItems.filter((i) => i.orderId === order.id);
        if (include.orderItems.include?.product) {
          items = items.map((i) => ({
            ...i,
            product: db.products[i.productId],
          }));
        }
        result.orderItems = items;
      }
      return result;
    }),
    create: jest.fn(async ({ data }) => {
      const id = genId();
      const order = {
        id,
        createdAt: Date.now(),
        paymentStatus: 'pending',
        payment_order_id: null,
        payment_id: null,
        ...data,
      };
      db.orders[id] = order;
      return order;
    }),
    update: jest.fn(async ({ where, data }) => {
      const order = db.orders[where.id];
      if (!order) throw new Error(`fake db: order ${where.id} not found`);
      Object.assign(order, data);
      return order;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      Object.values(db.orders).forEach((o) => {
        let match = true;
        if (
          where.payment_order_id !== undefined &&
          o.payment_order_id !== where.payment_order_id
        )
          match = false;
        if (
          where.paymentStatus?.not !== undefined &&
          o.paymentStatus === where.paymentStatus.not
        )
          match = false;
        if (match) {
          Object.assign(o, data);
          count += 1;
        }
      });
      return { count };
    }),
    findUnique: jest.fn(async ({ where, include }) => {
      let order;
      if (where.id) order = db.orders[where.id];
      else if (where.payment_order_id) {
        order = Object.values(db.orders).find(
          (o) => o.payment_order_id === where.payment_order_id
        );
      }
      if (!order) return null;

      const result = { ...order };
      if (include?.orderItems) {
        let items = db.orderItems.filter((i) => i.orderId === order.id);
        if (include.orderItems.include?.product) {
          items = items.map((i) => ({
            ...i,
            product: db.products[i.productId],
          }));
        }
        result.orderItems = items;
      }
      return result;
    }),
  },
  orderItem: {
    deleteMany: jest.fn(async ({ where }) => {
      const before = db.orderItems.length;
      db.orderItems = db.orderItems.filter((i) => i.orderId !== where.orderId);
      return { count: before - db.orderItems.length };
    }),
    create: jest.fn(async ({ data }) => {
      const item = { id: genId(), ...data };
      db.orderItems.push(item);
      return item;
    }),
  },
  product: {
    findUnique: jest.fn(async ({ where }) => db.products[where.id] || null),
    updateMany: jest.fn(async ({ where, data }) => {
      const product = db.products[where.id];
      let count = 0;

      // Atomic (synchronous) check-and-mutate, mirroring a single Mongo
      // document update — see tests/unit/inventory.concurrency.test.js for
      // more on why this faithfully models the real guarantee.
      if (product && product.stock >= where.stock.gte) {
        product.stock -= data.stock.decrement;
        count = 1;
      }

      // Latency *after* the atomic mutation, so concurrent requests in the
      // "simultaneous checkout" test below genuinely overlap in time.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));

      return { count };
    }),
  },
};
mockPrisma.$transaction = jest.fn(async (cb) => cb(mockPrisma));

jest.mock('@config/prisma', () => mockPrisma);

// -- Cart-clearing queue: simulate the worker inline (deleteMany against
// the same fake db) instead of standing up real BullMQ/Redis. -------------
const mockCartQueue = {
  add: jest.fn(async (name, data) => {
    if (name === 'clear-cart') {
      await mockPrisma.cart.deleteMany({ where: { userId: data.userId } });
    }
  }),
};
jest.mock('../../src/jobs/queues/clearCartQueue', () => mockCartQueue);

// -- Notification queue: payment.service.js queues an 'order-confirmation'
// job on every path that confirms an order (COD, /verify, and the
// webhook). Left unmocked, requiring it pulls in the real BullMQ Queue,
// which opens a real ioredis connection to 127.0.0.1:6379 — with no Redis
// available in the test environment, `.add()` never resolves and the test
// times out instead of failing fast on an assertion.
const mockNotificationQueue = { add: jest.fn(async () => {}) };
jest.mock(
  '../../src/jobs/queues/notificationQueue',
  () => mockNotificationQueue
);

// -- Redis: createDraftOrderService now takes a short-lived per-user lock
// via @config/redis directly (see order.service.js) — same "never hit a
// real connection" reasoning as the queues above. A tiny in-memory
// NX-respecting stand-in keeps the lock's actual acquire/release semantics
// (rather than always-succeeding stubs) so a real double-tap-style race
// within one test would still surface as a 409, same as it would in prod.
const redisLockStore = new Map();
const mockRedis = {
  set: jest.fn(async (key, value, mode, ttl, flag) => {
    if (flag === 'NX' && redisLockStore.has(key)) return null;
    redisLockStore.set(key, value);
    return 'OK';
  }),
  del: jest.fn(async (key) => {
    const existed = redisLockStore.delete(key);
    return existed ? 1 : 0;
  }),
  // paymentCreateOrderRateLimiter (rateLimiter.js, applied to
  // POST /api/payment/create-orderid — Pattern 17) calls incr/expire on
  // every request through this file's real checkout flow. Always resolving
  // to 1 keeps every attempt well under the limiter's threshold, so this
  // suite exercises the real checkout pipeline rather than the rate
  // limiter's own behavior (that's rateLimiter.test.js/payment.routes.test.js's
  // job).
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
};
jest.mock('@config/redis', () => mockRedis);

const Razorpay = require('razorpay');
const cartRoutes = require('@modules/cart/cart.routes');
const orderRoutes = require('@modules/order/order.routes');
const paymentRoutes = require('@modules/payment/payment.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const razorpayInstance = Razorpay.mock.results[0].value;

const buildApp = () => {
  const app = express();
  app.use(
    express.json({
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(responseMiddleware);
  app.use('/api/cart', cartRoutes);
  app.use('/api/order', orderRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  redisLockStore.clear();
  // jest.clearAllMocks() wipes the razorpay mock's constructor call log too,
  // but the *instance* it already returned (captured above) is unaffected —
  // only its own jest.fn() methods need re-arming per test where used.
});

describe('checkout flow — Cash on Delivery', () => {
  it('takes a cart all the way to a confirmed COD order and clears the cart + decrements stock', async () => {
    const product = seedProduct({ price: 500, stock: 10 });
    const address = seedAddress('user_1');

    // 1. Add item to cart
    const cartRes = await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 2 }] });
    expect(cartRes.status).toBe(200);

    const getCartRes = await request(app)
      .get('/api/cart')
      .set('x-user-id', 'user_1');
    expect(getCartRes.body.data).toHaveLength(1);
    expect(getCartRes.body.data[0].quantity).toBe(2);

    // 2. Create the draft order from the cart
    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    expect(draftRes.status).toBe(201);
    expect(draftRes.body.data.total).toBe(1000); // 500 * 2
    expect(draftRes.body.data.status).toBe('draft');
    const orderId = draftRes.body.data.id;

    // 3. Place a COD order for it
    const codRes = await request(app)
      .post('/api/payment/cod')
      .set('x-user-id', 'user_1')
      .send({ orderId, method: 'cod' });

    expect(codRes.status).toBe(200);
    expect(codRes.body.message).toBe('COD order placed successfully');
    expect(codRes.body.data.order.status).toBe('confirmed');
    expect(codRes.body.data.order.paymentStatus).toBe('cod_pending');

    // Stock was decremented exactly once, by the quantity ordered.
    expect(db.products[product.id].stock).toBe(8);

    // Cart was cleared once the order was actually confirmed.
    const cartAfter = await request(app)
      .get('/api/cart')
      .set('x-user-id', 'user_1');
    expect(cartAfter.body.data).toEqual([]);
  });

  it('409s a COD order whose cart no longer has enough stock, without touching the cart', async () => {
    // Enough stock to get 2 units into the cart in the first place — the
    // cart itself now guards against adding more than is in stock (see
    // cart.service's assertProductAvailable), and draft-order creation
    // re-validates stock too (order.service's own insufficientStock guard),
    // so this test models stock being depleted by someone else *after* the
    // draft order was already created with 2 units locked in — the race
    // the COD-placement step's own stock guard (inventory.service) still
    // has to catch, since a draft order can sit around for a while before
    // the customer actually pays/confirms.
    const product = seedProduct({ price: 500, stock: 2 });
    const address = seedAddress('user_1');

    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 2 }] });

    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    expect(draftRes.status).toBe(201);
    const orderId = draftRes.body.data.id;

    // Someone else's order (or a stock correction) eats into the supply
    // between draft-order creation and the customer actually placing the
    // COD order.
    db.products[product.id].stock = 1;

    const codRes = await request(app)
      .post('/api/payment/cod')
      .set('x-user-id', 'user_1')
      .send({ orderId, method: 'cod' });

    expect(codRes.status).toBe(409);
    // No money changed hands for COD, so the shortfall is a hard failure —
    // the order stays in draft and the cart survives for the user to retry.
    expect(db.orders[orderId].status).toBe('draft');
    const cartAfter = await request(app)
      .get('/api/cart')
      .set('x-user-id', 'user_1');
    expect(cartAfter.body.data).toHaveLength(1);
  });

  it("rejects placing a COD order for another user's order", async () => {
    const product = seedProduct({ price: 500, stock: 10 });
    const address = seedAddress('user_1');

    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });

    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    const orderId = draftRes.body.data.id;

    const codRes = await request(app)
      .post('/api/payment/cod')
      .set('x-user-id', 'user_2') // different shopper
      .send({ orderId, method: 'cod' });

    expect(codRes.status).toBe(403);
    expect(db.orders[orderId].status).toBe('draft');
  });
});

describe('checkout flow — Razorpay online payment', () => {
  it('takes a cart all the way to a verified, confirmed order', async () => {
    const product = seedProduct({ price: 750, stock: 10 });
    const address = seedAddress('user_1');

    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });

    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    const orderId = draftRes.body.data.id;

    razorpayInstance.orders.create.mockResolvedValue({ id: 'rzp_order_1' });

    const createOrderIdRes = await request(app)
      .post('/api/payment/create-orderid')
      .set('x-user-id', 'user_1')
      .send();

    expect(createOrderIdRes.status).toBe(200);
    expect(createOrderIdRes.body.data.order.id).toBe('rzp_order_1');
    expect(db.orders[orderId].payment_order_id).toBe('rzp_order_1');

    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update('rzp_order_1|pay_1')
      .digest('hex');

    // /verify now independently fetches the payment from Razorpay and
    // checks its real captured status/amount against the order total
    // (750 * 100 paise) before trusting the signature-valid ids.
    razorpayInstance.payments.fetch.mockResolvedValue({
      order_id: 'rzp_order_1',
      status: 'captured',
      amount: 75000,
    });

    const verifyRes = await request(app)
      .post('/api/payment/verify')
      .set('x-user-id', 'user_1')
      .send({
        razorpay_order_id: 'rzp_order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: signature,
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.message).toBe('Payment verified successfully');
    expect(db.orders[orderId].status).toBe('confirmed');
    expect(db.orders[orderId].paymentStatus).toBe('paid');
    expect(db.products[product.id].stock).toBe(9);

    const cartAfter = await request(app)
      .get('/api/cart')
      .set('x-user-id', 'user_1');
    expect(cartAfter.body.data).toEqual([]);
  });

  it('rejects verification with a forged signature and leaves the order untouched', async () => {
    const product = seedProduct({ price: 750, stock: 10 });
    const address = seedAddress('user_1');

    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });

    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    const orderId = draftRes.body.data.id;

    razorpayInstance.orders.create.mockResolvedValue({ id: 'rzp_order_2' });
    await request(app)
      .post('/api/payment/create-orderid')
      .set('x-user-id', 'user_1')
      .send();

    const verifyRes = await request(app)
      .post('/api/payment/verify')
      .set('x-user-id', 'user_1')
      .send({
        razorpay_order_id: 'rzp_order_2',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: 'not-the-real-signature',
      });

    expect(verifyRes.status).toBe(400);
    expect(db.orders[orderId].status).toBe('draft');
    // paymentStatus moved to 'attempted' the moment create-orderid minted a
    // Razorpay order for this draft — a forged-signature /verify call never
    // gets far enough to change it further.
    expect(db.orders[orderId].paymentStatus).toBe('attempted');
    expect(db.products[product.id].stock).toBe(10);
  });

  it('rejects verification when the actual Razorpay payment amount is short of the order total', async () => {
    const product = seedProduct({ price: 750, stock: 10 });
    const address = seedAddress('user_1');

    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_1')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });

    const draftRes = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_1')
      .send({ selectedAddressId: address.id });
    const orderId = draftRes.body.data.id;

    razorpayInstance.orders.create.mockResolvedValue({ id: 'rzp_order_3' });
    await request(app)
      .post('/api/payment/create-orderid')
      .set('x-user-id', 'user_1')
      .send();

    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update('rzp_order_3|pay_1')
      .digest('hex');

    // A valid signature, but the payment Razorpay actually captured (if
    // any) doesn't match what this order is for — e.g. tampered client
    // amount, or a captured payment for a different, cheaper order reused
    // here. This must be caught independently of the signature.
    razorpayInstance.payments.fetch.mockResolvedValue({
      order_id: 'rzp_order_3',
      status: 'captured',
      amount: 1,
    });

    const verifyRes = await request(app)
      .post('/api/payment/verify')
      .set('x-user-id', 'user_1')
      .send({
        razorpay_order_id: 'rzp_order_3',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: signature,
      });

    expect(verifyRes.status).toBe(400);
    expect(verifyRes.body.message).toBe(
      'Payment amount does not match order total'
    );
    expect(db.orders[orderId].status).toBe('draft');
    // Same as the forged-signature case above — create-orderid already
    // moved this to 'attempted'; a rejected /verify call doesn't change it.
    expect(db.orders[orderId].paymentStatus).toBe('attempted');
    expect(db.products[product.id].stock).toBe(10);
  });
});

describe('checkout flow — simultaneous purchase of the last item', () => {
  it('confirms exactly one of two shoppers racing to COD-checkout the last unit', async () => {
    const product = seedProduct({ price: 500, stock: 1 });
    const addressA = seedAddress('user_a');
    const addressB = seedAddress('user_b');

    // Both shoppers independently add the same (last-unit) product to
    // their own carts and create their own draft orders first.
    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_a')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });
    await request(app)
      .post('/api/cart')
      .set('x-user-id', 'user_b')
      .send({ cartItems: [{ productId: product.id, quantity: 1 }] });

    const draftA = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_a')
      .send({ selectedAddressId: addressA.id });
    const draftB = await request(app)
      .post('/api/order')
      .set('x-user-id', 'user_b')
      .send({ selectedAddressId: addressB.id });

    const orderIdA = draftA.body.data.id;
    const orderIdB = draftB.body.data.id;

    // Now both shoppers hit "place order" at effectively the same instant.
    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/payment/cod')
        .set('x-user-id', 'user_a')
        .send({ orderId: orderIdA, method: 'cod' }),
      request(app)
        .post('/api/payment/cod')
        .set('x-user-id', 'user_b')
        .send({ orderId: orderIdB, method: 'cod' }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one checkout wins (200), the other loses to the stock guard (409).
    expect(statuses).toEqual([200, 409]);

    const winner = resA.status === 200 ? 'user_a' : 'user_b';
    const loser = winner === 'user_a' ? 'user_b' : 'user_a';
    const winnerOrderId = winner === 'user_a' ? orderIdA : orderIdB;
    const loserOrderId = loser === 'user_a' ? orderIdA : orderIdB;

    expect(db.orders[winnerOrderId].status).toBe('confirmed');
    expect(db.orders[loserOrderId].status).toBe('draft');

    // Stock lands at exactly zero — never negative, never still 1.
    expect(db.products[product.id].stock).toBe(0);

    // Only the winner's cart was cleared.
    const winnerCart = await request(app)
      .get('/api/cart')
      .set('x-user-id', winner);
    const loserCart = await request(app)
      .get('/api/cart')
      .set('x-user-id', loser);
    expect(winnerCart.body.data).toEqual([]);
    expect(loserCart.body.data).toHaveLength(1);
  });
});
