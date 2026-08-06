const express = require('express');
const request = require('supertest');

const mockRedis = { incr: jest.fn(), expire: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

// Explicit factory (rather than automock) so requiring this test file never
// pulls in the real otp.service.js — and with it, real Redis/Twilio/Prisma
// client construction that would otherwise try to open connections.
jest.mock('@modules/otp/otp.service', () => ({
  sendOtpService: jest.fn(),
  verifyOtpService: jest.fn(),
}));

const otpService = require('@modules/otp/otp.service');
const otpRoutes = require('@modules/otp/otp.routes');
const responseMiddleware = require('@middlewares/responseMiddleware');
const errorHandler = require('@middlewares/errorHandler');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(responseMiddleware);
  app.use('/api/otp', otpRoutes);
  app.use(errorHandler);
  return app;
};

const app = buildApp();

beforeEach(() => {
  mockRedis.incr.mockReset().mockResolvedValue(1);
  mockRedis.expire.mockReset().mockResolvedValue(1);
});

describe('POST /api/otp/send-otp', () => {
  it('422s on a non-Indian / malformed phone number', async () => {
    const res = await request(app)
      .post('/api/otp/send-otp')
      .send({ phone: '12345' });

    expect(res.status).toBe(422);
    expect(otpService.sendOtpService).not.toHaveBeenCalled();
  });

  it('sends an OTP for a valid phone number', async () => {
    otpService.sendOtpService.mockResolvedValue();

    const res = await request(app)
      .post('/api/otp/send-otp')
      .send({ phone: '+919876543210' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('OTP sent successfully');
    expect(otpService.sendOtpService).toHaveBeenCalledWith('+919876543210');
  });

  it('429s once the per-phone send rate limit is exceeded', async () => {
    mockRedis.incr.mockResolvedValue(6); // limiter maxAttempts is 5
    otpService.sendOtpService.mockResolvedValue();

    const res = await request(app)
      .post('/api/otp/send-otp')
      .send({ phone: '+919876543210' });

    expect(res.status).toBe(429);
    expect(otpService.sendOtpService).not.toHaveBeenCalled();
  });
});

describe('POST /api/otp/verify-otp', () => {
  it('422s when the OTP is not 6 digits', async () => {
    const res = await request(app)
      .post('/api/otp/verify-otp')
      .send({ phone: '+919876543210', otp: '123' });

    expect(res.status).toBe(422);
    expect(otpService.verifyOtpService).not.toHaveBeenCalled();
  });

  it('logs the user in and returns only id/phone on success', async () => {
    otpService.verifyOtpService.mockResolvedValue({
      token: 'jwt-token',
      user: {
        id: 'user_1',
        phone: '+919876543210',
        email: '919876543210@advika.fake',
        password: '',
      },
      success: true,
    });

    const res = await request(app)
      .post('/api/otp/verify-otp')
      .send({ phone: '+919876543210', otp: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe('jwt-token');
    expect(res.body.data.user).toEqual({
      id: 'user_1',
      phone: '+919876543210',
    });
    // The controller deliberately only echoes id/phone — make sure it never
    // starts leaking the internal placeholder email/password fields.
    expect(res.body.data.user.email).toBeUndefined();
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('propagates an invalid/expired OTP as the correct status code', async () => {
    const CustomError = require('@utils/customError');
    otpService.verifyOtpService.mockRejectedValue(
      new CustomError('OTP not found or expired', 404)
    );

    const res = await request(app)
      .post('/api/otp/verify-otp')
      .send({ phone: '+919876543210', otp: '123456' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('OTP not found or expired');
  });
});
