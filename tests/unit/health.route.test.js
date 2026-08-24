// tests/unit/health.route.test.js
//
// Regression test for a real bug found via E2E testing: GET /health used
// to await prisma.$runCommandRaw({ping:1}) with no timeout of its own,
// inheriting Prisma's MongoDB connector default serverSelectionTimeoutMS
// of 30s when the database is unreachable. That's far past this repo's
// own docker-compose healthcheck (interval 10s / timeout 5s), so an
// outage meant the orchestrator's probe always timed out from its own
// side without ever seeing this endpoint's {status:'error'} body — the
// one signal the healthcheck exists to surface. Fixed by racing the ping
// against a 4s local timeout (src/routes/health.js).
const express = require('express');
const request = require('supertest');

const mockPing = jest.fn();
jest.mock('@config/prisma', () => ({
  $runCommandRaw: (...args) => mockPing(...args),
}));

const mockRedis = { status: 'ready', ping: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

const healthRoute = require('@routes/health');

const buildApp = () => {
  const app = express();
  app.use('/health', healthRoute);
  return app;
};

const app = buildApp();

describe('GET /health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.status = 'ready';
    mockRedis.ping.mockResolvedValue('PONG');
  });

  it('200s with both checks ok when database and redis are reachable', async () => {
    mockPing.mockResolvedValue({ ok: 1 });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'ok',
        checks: { database: 'ok', redis: 'ok' },
      })
    );
  });

  it('503s promptly (well under 30s) instead of hanging when the database ping never resolves', async () => {
    // Simulates exactly what an unreachable MongoDB looks like from
    // Prisma's perspective: the promise just never settles until its own
    // internal server-selection timeout (30s) fires.
    mockPing.mockImplementation(() => new Promise(() => {}));

    const start = Date.now();
    const res = await request(app).get('/health');
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe('error');
    // Bounded by health.js's own 4s timeout, not Prisma's 30s default —
    // generous upper bound here to avoid CI flakiness while still failing
    // hard if the timeout regresses back to "none".
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('503s when the database ping rejects immediately (e.g. connection refused)', async () => {
    mockPing.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'error',
        checks: { database: 'error', redis: 'ok' },
      })
    );
  });

  it('503s when redis is not ready, independent of the database check', async () => {
    mockPing.mockResolvedValue({ ok: 1 });
    mockRedis.status = 'connecting';

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'error' });
  });

  it('never leaks a stack trace or connection string in the response body', async () => {
    mockPing.mockRejectedValue(
      new Error('connect ECONNREFUSED mongodb://user:password@10.0.0.5:27017')
    );

    const res = await request(app).get('/health');

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/user:password/);
    expect(body).not.toMatch(/at .*\(.*:\d+:\d+\)/); // stack-frame shape
  });
});
