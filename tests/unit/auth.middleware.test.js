const jwt = require('jsonwebtoken');
const authenticate = require('@middlewares/authenticate');
const authorizeAdminOnly = require('@middlewares/authorizeAdminOnly');

const mockRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('authenticate middleware', () => {
  it('rejects with 401 when no Authorization header is present', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Access denied. No token provided.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 400 for a malformed/invalid token', () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' } };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 400 for a token signed with the wrong secret', () => {
    const badToken = jwt.sign({ userId: 'user_1' }, 'someone-elses-secret');
    const req = { headers: { authorization: `Bearer ${badToken}` } };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 400 for an expired token', () => {
    const expiredToken = jwt.sign(
      { userId: 'user_1' },
      process.env.JWT_SECRET,
      { expiresIn: -10 }
    );
    const req = { headers: { authorization: `Bearer ${expiredToken}` } };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the decoded payload to req.user and calls next() for a valid token', () => {
    const token = jwt.sign(
      { userId: 'user_1', role: 'customer' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ userId: 'user_1', role: 'customer' });
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('authorizeAdminOnly middleware', () => {
  it('rejects non-admin users with 403', () => {
    const req = { user: { role: 'customer' } };
    const res = mockRes();
    const next = jest.fn();

    authorizeAdminOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for admin users', () => {
    const req = { user: { role: 'admin' } };
    const res = mockRes();
    const next = jest.fn();

    authorizeAdminOnly(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
