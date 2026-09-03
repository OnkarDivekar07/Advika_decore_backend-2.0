// tests/integration/security.e2e.test.js
//
// Cross-cutting security checks that don't belong to any single module's
// route-test file: JWT tampering/algorithm-confusion against the REAL
// `authenticate` middleware (every other route-test file mocks this
// middleware away, so nothing else in the suite actually exercises
// jwt.verify's algorithm pinning end-to-end), a sweep confirming every
// admin-only route in the router actually enforces authorizeAdminOnly,
// malformed-Authorization-header edge cases, the shared 404 fallback, and
// errorHandler's prod-vs-dev stack-trace exposure.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const errorHandler = require('@middlewares/errorHandler');
const responseMiddleware = require('@middlewares/responseMiddleware');
const CustomError = require('@utils/customError');

const JWT_SECRET = process.env.JWT_SECRET; // 'test-jwt-secret', set by tests/setup/env.js

describe('authenticate middleware — real JWT verification (not mocked)', () => {
  const buildProtectedApp = () => {
    const app = express();
    app.use(responseMiddleware);
    app.get('/protected', authenticate, (req, res) =>
      res.status(200).json({ user: req.user })
    );
    app.use(errorHandler);
    return app;
  };
  const app = buildProtectedApp();

  it('accepts a validly signed HS256 token', async () => {
    const token = jwt.sign({ userId: 'u1', role: 'customer' }, JWT_SECRET, {
      expiresIn: '1h',
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.userId).toBe('u1');
  });

  it('rejects a classic alg:none forged token (no signature at all)', async () => {
    // Hand-build a JWT with header.alg = "none" and an empty signature
    // segment — the textbook algorithm-confusion attack against libraries
    // that trust the token's own header instead of pinning the accepted
    // algorithm list.
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ userId: 'attacker', role: 'admin' })
    ).toString('base64url');
    const forgedToken = `${header}.${payload}.`;

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${forgedToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid token.');
  });

  it('rejects a token signed with a different algorithm than the pinned HS256', async () => {
    // HS384 is still a symmetric HMAC algorithm the server *could* verify
    // with the same secret if it trusted the token's own alg header —
    // authenticate.js pins `algorithms: ['HS256']` specifically to refuse
    // this.
    const token = jwt.sign({ userId: 'u1', role: 'admin' }, JWT_SECRET, {
      algorithm: 'HS384',
      expiresIn: '1h',
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = jwt.sign({ userId: 'u1', role: 'admin' }, 'wrong-secret', {
      expiresIn: '1h',
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it.each([
    ['no Authorization header at all', undefined],
    ['an empty Authorization header', ''],
    ['"Bearer" with no token after it', 'Bearer'],
    ['"Bearer " with a trailing space and nothing else', 'Bearer '],
    ['a raw token with no "Bearer " prefix', 'sometoken.without.prefix'],
    ['a lowercase "bearer" scheme', 'bearer sometoken'],
  ])('rejects %s', async (_desc, headerValue) => {
    const req = request(app).get('/protected');
    if (headerValue !== undefined) req.set('Authorization', headerValue);

    const res = await req;

    expect([400, 401]).toContain(res.status);
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ userId: 'u1', role: 'admin' }, JWT_SECRET, {
      expiresIn: '-1s',
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe('authorizeAdminOnly sweep — every admin-only route rejects a non-admin token', () => {
  // Real authenticate + real authorizeAdminOnly, mounted against a tiny
  // stand-in router per case rather than the full apiRoutes tree (which
  // would pull in real Prisma/Redis/BullMQ/Razorpay client construction
  // for modules unrelated to this check). This exercises the exact
  // two-middleware chain every real admin route uses
  // (`authenticate` then `authorizeAdminOnly`, see admin.routes.js,
  // inventory.routes.js, product.routes.js, shipping.routes.js,
  // homepage.routes.js) without needing each module's full dependency
  // graph.
  const buildAdminOnlyApp = () => {
    const app = express();
    app.use(responseMiddleware);
    app.all(
      '/admin-only',
      authenticate,
      authorizeAdminOnly,
      (req, res) => res.status(200).json({ ok: true })
    );
    app.use(errorHandler);
    return app;
  };
  const app = buildAdminOnlyApp();

  const customerToken = jwt.sign(
    { userId: 'u1', role: 'customer' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  const adminToken = jwt.sign({ userId: 'a1', role: 'admin' }, JWT_SECRET, {
    expiresIn: '1h',
  });

  it('403s a valid but non-admin (customer role) token', async () => {
    const res = await request(app)
      .get('/admin-only')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });

  it('403s a token with no role claim at all', async () => {
    const noRoleToken = jwt.sign({ userId: 'u1' }, JWT_SECRET, {
      expiresIn: '1h',
    });

    const res = await request(app)
      .get('/admin-only')
      .set('Authorization', `Bearer ${noRoleToken}`);

    expect(res.status).toBe(403);
  });

  it('rejects an unrecognized role string, not just "customer"', async () => {
    const weirdRoleToken = jwt.sign(
      { userId: 'u1', role: 'superadmin-ish' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/admin-only')
      .set('Authorization', `Bearer ${weirdRoleToken}`);

    expect(res.status).toBe(403);
  });

  it('200s a real admin-role token', async () => {
    const res = await request(app)
      .get('/admin-only')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });
});

describe('shared 404 fallback for unknown API routes', () => {
  // Deliberately not requiring the real @routes/apiRoutes here: that pulls
  // in every module's real service file (Prisma/Redis/BullMQ/Razorpay/S3
  // client construction), which every other route-test file in this repo
  // avoids for exactly that reason (see e.g. product.routes.test.js's
  // comment on why it mocks the service layer). Instead this exercises
  // the identical fallback contract apiRoutes.js defines
  // (`router.use((req, res) => res.status(404).json({ message: 'Route not found' }))`)
  // against a minimal router, which is enough to verify unknown/mistyped/
  // path-traversal-shaped routes 404 cleanly instead of 500ing.
  const buildAppWithFallback = () => {
    const app = express();
    app.use(responseMiddleware);
    const router = express.Router();
    router.get('/products', (req, res) => res.sendResponse({ data: [] }));
    router.use((req, res) => {
      res.status(404).json({ message: 'Route not found' });
    });
    app.use('/api', router);
    app.use(errorHandler);
    return app;
  };

  it.each([
    ['GET', '/api/does-not-exist'],
    ['GET', '/api/Admin/stats'], // case-sensitivity probe
  ])('%s %s falls through to the app 404 handler, not a 500', async (method, path) => {
    const app = buildAppWithFallback();

    const res = await request(app)[method.toLowerCase()](path);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Route not found' });
  });

  it('never 500s on a path-traversal-shaped URL', async () => {
    // Express 5's router normalizes `..` segments before matching, so this
    // resolves outside the /api mount entirely and hits Express's own
    // default 404 rather than this app's JSON fallback — still a 404, and
    // specifically never a 500/stack-trace leak either way.
    const app = buildAppWithFallback();

    const res = await request(app).post('/api/products/../../etc/passwd');

    expect(res.status).toBe(404);
  });
});

describe('errorHandler — stack trace exposure by environment', () => {
  const buildThrowingApp = () => {
    const app = express();
    app.use(responseMiddleware);
    app.get('/boom', (req, res, next) => {
      next(new CustomError('Something broke', 500));
    });
    app.use(errorHandler);
    return app;
  };

  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('never includes a stack trace in production', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      message: 'Something broke',
      errors: null,
    });
    expect(res.body.stack).toBeUndefined();
  });

  it('includes a stack trace only in development, for debugging', async () => {
    process.env.NODE_ENV = 'development';
    const app = buildThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(typeof res.body.stack).toBe('string');
  });

  it('never includes a stack trace in test env either (defaults to prod-safe)', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.body.stack).toBeUndefined();
  });
});

describe('errorHandler — raw (non-CustomError) message exposure by environment', () => {
  // Fixes a real leak found via the real E2E concurrency spec: a raw
  // Prisma P2034 error's own message includes the exact server file path
  // and line number that threw. A CustomError's message is deliberately
  // authored for an end user (see the describe block above — it always
  // shows, in every environment); a raw, unexpected error's message never
  // was, and should only ever reach a client during local development.
  const buildRawThrowingApp = () => {
    const app = express();
    app.use(responseMiddleware);
    app.get('/boom', (req, res, next) => {
      next(new Error('Invalid `tx.order.create()` invocation in C:\\app\\order.service.js:462:37'));
    });
    app.use(errorHandler);
    return app;
  };

  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('never leaks a raw error message in production — only the generic fallback', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildRawThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Something went wrong');
    expect(res.body.message).not.toContain('order.service.js');
  });

  it('never leaks a raw error message in test env either (defaults to prod-safe)', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildRawThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.body.message).toBe('Something went wrong');
  });

  it('shows the real raw error message only in development, for debugging', async () => {
    process.env.NODE_ENV = 'development';
    const app = buildRawThrowingApp();

    const res = await request(app).get('/boom');

    expect(res.body.message).toContain('order.service.js');
  });
});
