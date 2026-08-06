const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');
const errorHandler = require('@middlewares/errorHandler');

const app = express();
app.get('/protected', authenticate, (req, res) =>
  res.json({ userId: req.user.userId })
);
app.get('/admin-only', authenticate, authorizeAdminOnly, (req, res) =>
  res.json({ ok: true })
);
app.use(errorHandler);

const token = (payload, opts = { expiresIn: '1h' }) =>
  jwt.sign(payload, process.env.JWT_SECRET, opts);

describe('authenticate + authorizeAdminOnly wired through real routes', () => {
  it('401s with no Authorization header', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('400s with a token signed by someone else', async () => {
    const forged = jwt.sign({ userId: 'user_1' }, 'not-our-secret');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(400);
  });

  it('200s and exposes the decoded user for a valid token', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token({ userId: 'user_1', role: 'customer' })}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user_1');
  });

  it('403s a non-admin on an admin-only route', async () => {
    const res = await request(app)
      .get('/admin-only')
      .set(
        'Authorization',
        `Bearer ${token({ userId: 'user_1', role: 'customer' })}`
      );

    expect(res.status).toBe(403);
  });

  it('200s an admin on an admin-only route', async () => {
    const res = await request(app)
      .get('/admin-only')
      .set(
        'Authorization',
        `Bearer ${token({ userId: 'admin_1', role: 'admin' })}`
      );

    expect(res.status).toBe(200);
  });
});
