const express = require('express');
const request = require('supertest');

// user.routes -> @middlewares/rateLimiter (for the phone-change OTP
// endpoints) -> @config/redis, which would otherwise open a real Redis
// connection just from requiring the routes below.
const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

jest.mock('@middlewares/authenticate', () =>
  jest.fn((req, res, next) => {
    req.user = { userId: 'user_1', role: 'customer' };
    next();
  })
);
jest.mock('@modules/user/user.service');

const userService = require('@modules/user/user.service');
const userRoutes = require('@modules/user/user.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/user', userRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

// Phone is E.164 ("+91" + 10 digits, first digit 6-9) — matching what the
// frontend actually sends (src/utils/phoneValidation.js's toE164) and the
// otp module's own validator, not the looser shape the old
// `.isMobilePhone()` check used to accept.
const validAddress = {
  name: 'Jane Doe',
  phone: '+919876543210',
  pincode: '411001',
  city: 'Pune',
  state: 'Maharashtra',
  houseArea: '221B Baker St',
  area: 'Kothrud',
};

describe('POST /api/user/address', () => {
  it('422s on a missing required field', async () => {
    const { name, ...rest } = validAddress;
    const res = await request(app).post('/api/user/address').send(rest);

    expect(res.status).toBe(422);
    expect(userService.createAddress).not.toHaveBeenCalled();
  });

  it('422s on a missing area', async () => {
    const { area, ...rest } = validAddress;
    const res = await request(app).post('/api/user/address').send(rest);

    expect(res.status).toBe(422);
    expect(userService.createAddress).not.toHaveBeenCalled();
  });

  it('422s on an invalid Indian pincode', async () => {
    const res = await request(app)
      .post('/api/user/address')
      .send({ ...validAddress, pincode: '123' });

    expect(res.status).toBe(422);
  });

  it('422s on an Indian pincode starting with 0', async () => {
    const res = await request(app)
      .post('/api/user/address')
      .send({ ...validAddress, pincode: '011001' });

    expect(res.status).toBe(422);
  });

  it('422s on a phone number missing the +91 country code', async () => {
    const res = await request(app)
      .post('/api/user/address')
      .send({ ...validAddress, phone: '9876543210' });

    expect(res.status).toBe(422);
  });

  it('422s on a phone number with an invalid first digit', async () => {
    const res = await request(app)
      .post('/api/user/address')
      .send({ ...validAddress, phone: '+915876543210' });

    expect(res.status).toBe(422);
  });

  it('creates the address, scoped to the authenticated user', async () => {
    userService.createAddress.mockResolvedValue({ id: 'addr1', ...validAddress, isDefault: true });

    const res = await request(app)
      .post('/api/user/address')
      .send(validAddress);

    expect(res.status).toBe(200);
    expect(userService.createAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        ...validAddress,
        user: { connect: { id: 'user_1' } },
      })
    );
  });
});

describe('GET /api/user/addresses', () => {
  it("returns the authenticated user's addresses", async () => {
    userService.getAddressesByUserId.mockResolvedValue([{ id: 'addr1' }]);

    const res = await request(app).get('/api/user/addresses');

    expect(res.status).toBe(200);
    expect(userService.getAddressesByUserId).toHaveBeenCalledWith('user_1');
    expect(res.body.data).toEqual([{ id: 'addr1' }]);
  });
});

describe('PUT /api/user/address/:id', () => {
  it('422s an invalid pincode on update', async () => {
    const res = await request(app)
      .put('/api/user/address/addr1')
      .send({ pincode: 'not-a-pincode' });

    expect(res.status).toBe(422);
    expect(userService.updateAddressById).not.toHaveBeenCalled();
  });

  it('updates the address for the authenticated user', async () => {
    userService.updateAddressById.mockResolvedValue({ id: 'addr1', city: 'Mumbai' });

    const res = await request(app)
      .put('/api/user/address/addr1')
      .send({ city: 'Mumbai' });

    expect(res.status).toBe(200);
    expect(userService.updateAddressById).toHaveBeenCalledWith(
      'addr1',
      'user_1',
      { city: 'Mumbai' }
    );
  });

  it('propagates a 403 when the address belongs to someone else', async () => {
    const CustomError = require('@utils/customError');
    userService.updateAddressById.mockRejectedValue(
      new CustomError('Address not found or unauthorized', 403)
    );

    const res = await request(app)
      .put('/api/user/address/addr1')
      .send({ city: 'Mumbai' });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/user/address/:id', () => {
  it('deletes the address for the authenticated user', async () => {
    userService.deleteAddressById.mockResolvedValue({ id: 'addr1' });

    const res = await request(app).delete('/api/user/address/addr1');

    expect(res.status).toBe(200);
    expect(userService.deleteAddressById).toHaveBeenCalledWith(
      'addr1',
      'user_1'
    );
  });

  it('propagates a 409 when the address is linked to past orders', async () => {
    const CustomError = require('@utils/customError');
    userService.deleteAddressById.mockRejectedValue(
      new CustomError(
        'This address is linked to past orders and cannot be deleted. You can add a new address instead.',
        409
      )
    );

    const res = await request(app).delete('/api/user/address/addr1');

    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/user/address/:id/default', () => {
  it('marks the address as default for the authenticated user', async () => {
    userService.setDefaultAddressById.mockResolvedValue({ id: 'addr1', isDefault: true });

    const res = await request(app).patch('/api/user/address/addr1/default');

    expect(res.status).toBe(200);
    expect(userService.setDefaultAddressById).toHaveBeenCalledWith('addr1', 'user_1');
    expect(res.body.data).toEqual({ id: 'addr1', isDefault: true });
  });

  it('propagates a 403 when the address belongs to someone else', async () => {
    const CustomError = require('@utils/customError');
    userService.setDefaultAddressById.mockRejectedValue(
      new CustomError('Address not found or unauthorized', 403)
    );

    const res = await request(app).patch('/api/user/address/addr1/default');

    expect(res.status).toBe(403);
  });
});

describe('GET /api/user/profile', () => {
  it("returns the authenticated user's profile", async () => {
    userService.getUserProfile.mockResolvedValue({
      id: 'user_1',
      name: 'Jane',
      email: 'jane@x.com',
    });

    const res = await request(app).get('/api/user/profile');

    expect(res.status).toBe(200);
    expect(userService.getUserProfile).toHaveBeenCalledWith('user_1');
    expect(res.body.data).toEqual({
      id: 'user_1',
      name: 'Jane',
      email: 'jane@x.com',
    });
  });

  it('404s when the profile lookup fails', async () => {
    const CustomError = require('@utils/customError');
    userService.getUserProfile.mockRejectedValue(
      new CustomError('User not found', 404)
    );

    const res = await request(app).get('/api/user/profile');
    expect(res.status).toBe(404);
  });
});
