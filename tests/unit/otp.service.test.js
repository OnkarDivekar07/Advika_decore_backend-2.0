const mockRedis = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
jest.mock('@config/redis', () => mockRedis);

const mockUser = { findUnique: jest.fn(), create: jest.fn() };
jest.mock('@config/prisma', () => ({ user: mockUser }));

const mockTwilioCreate = jest.fn();
jest.mock('twilio', () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: mockTwilioCreate },
  }))
);

jest.mock('@utils/generateToken', () => jest.fn(() => 'signed-jwt-token'));

const generateToken = require('@utils/generateToken');
const otpService = require('@modules/otp/otp.service');

describe('otp.service', () => {
  describe('sendOtpService', () => {
    beforeEach(() => {
      mockRedis.set.mockReset();
      mockTwilioCreate.mockReset().mockResolvedValue({ sid: 'SM123' });
    });

    it('stores a 6-digit OTP in Redis with a 5 minute TTL, keyed by phone', async () => {
      await otpService.sendOtpService('+919876543210');

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      const [key, otp, mode, ttl] = mockRedis.set.mock.calls[0];
      expect(key).toBe('otp:+919876543210');
      expect(otp).toMatch(/^\d{6}$/);
      expect(mode).toBe('EX');
      expect(ttl).toBe(300);
    });

    it('sends the same OTP that was stored via Twilio, to the given phone', async () => {
      await otpService.sendOtpService('+919876543210');

      const storedOtp = mockRedis.set.mock.calls[0][1];
      expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
      const smsArgs = mockTwilioCreate.mock.calls[0][0];
      expect(smsArgs.to).toBe('+919876543210');
      expect(smsArgs.from).toBe(process.env.TWILIO_PHONE);
      expect(smsArgs.body).toContain(storedOtp);
    });
  });

  describe('verifyOtpService', () => {
    beforeEach(() => {
      mockRedis.get.mockReset();
      mockRedis.del.mockReset();
      mockUser.findUnique.mockReset();
      mockUser.create.mockReset();
      generateToken.mockClear();
    });

    it('rejects with 404 when no OTP was ever sent (or it expired)', async () => {
      mockRedis.get.mockResolvedValue(null);

      await expect(
        otpService.verifyOtpService('+919876543210', '123456')
      ).rejects.toMatchObject({
        message: 'OTP not found or expired',
        statusCode: 404,
      });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('rejects with 400 on a wrong OTP without deleting the real one', async () => {
      mockRedis.get.mockResolvedValue('123456');

      await expect(
        otpService.verifyOtpService('+919876543210', '000000')
      ).rejects.toMatchObject({ message: 'Invalid OTP', statusCode: 400 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('logs in an existing user on a correct OTP and consumes it', async () => {
      mockRedis.get.mockResolvedValue('123456');
      mockUser.findUnique.mockResolvedValue({
        id: 'user_1',
        phone: '+919876543210',
        role: 'customer',
      });

      const result = await otpService.verifyOtpService(
        '+919876543210',
        '123456'
      );

      expect(mockRedis.del).toHaveBeenCalledWith('otp:+919876543210');
      expect(mockUser.create).not.toHaveBeenCalled();
      expect(generateToken).toHaveBeenCalledWith('user_1', 'customer');
      expect(result).toEqual({
        token: 'signed-jwt-token',
        user: { id: 'user_1', phone: '+919876543210', role: 'customer' },
        success: true,
      });
    });

    it('registers a new customer on first-time verification', async () => {
      mockRedis.get.mockResolvedValue('123456');
      mockUser.findUnique.mockResolvedValue(null);
      mockUser.create.mockResolvedValue({
        id: 'user_new',
        phone: '+919876543210',
        role: 'customer',
      });

      const result = await otpService.verifyOtpService(
        '+919876543210',
        '123456'
      );

      expect(mockUser.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: '+919876543210',
          role: 'customer',
        }),
      });
      expect(result.user.id).toBe('user_new');
      expect(result.token).toBe('signed-jwt-token');
    });
  });
});
