const mockUser = { findUnique: jest.fn(), create: jest.fn() };
jest.mock('@config/prisma', () => ({ user: mockUser }));

jest.mock('@utils/generateToken', () => jest.fn(() => 'signed-jwt-token'));

const generateToken = require('@utils/generateToken');
const otpService = require('@modules/otp/otp.service');

describe('otp.service', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.MSG91_AUTH_KEY = 'test-msg91-auth-key';
    process.env.MSG91_TEMPLATE_ID = 'test-template-id';
    global.fetch = jest.fn();
    mockUser.findUnique.mockReset();
    mockUser.create.mockReset();
    generateToken.mockClear();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('sendOtpService', () => {
    it('sends the Indian phone number to MSG91 using the configured OTP template', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'success', message: 'OTP sent successfully' }),
      });

      await otpService.sendOtpService('+91 9876543210');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [requestUrl, options] = global.fetch.mock.calls[0];
      const url = new URL(requestUrl);

      expect(url.origin + url.pathname).toBe('https://control.msg91.com/api/v5/otp');
      expect(url.searchParams.get('template_id')).toBe('test-template-id');
      expect(url.searchParams.get('mobile')).toBe('919876543210');
      expect(url.searchParams.get('authkey')).toBe('test-msg91-auth-key');
      expect(options.method).toBe('POST');
    });

    it('throws a 502 when MSG91 rejects the send request', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'error', message: 'Template not found' }),
      });

      await expect(
        otpService.sendOtpService('+919876543210')
      ).rejects.toMatchObject({ statusCode: 502 });
    });
  });

  describe('verifyOtpService', () => {
    it('verifies the OTP through MSG91 before logging the user in', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'success', message: 'OTP verified success' }),
      });
      mockUser.findUnique.mockResolvedValue({
        id: 'user_1',
        phone: '9876543210',
        role: 'customer',
      });

      const result = await otpService.verifyOtpService(
        '+919876543210',
        '123456'
      );

      const [requestUrl, options] = global.fetch.mock.calls[0];
      const url = new URL(requestUrl);

      expect(url.pathname).toBe('/api/v5/otp/verify');
      expect(url.searchParams.get('otp')).toBe('123456');
      expect(url.searchParams.get('mobile')).toBe('919876543210');
      expect(options.method).toBe('GET');
      expect(options.headers.authkey).toBe('test-msg91-auth-key');
      expect(mockUser.findUnique).toHaveBeenCalledWith({
        where: { phone: '9876543210' },
      });
      expect(generateToken).toHaveBeenCalledWith('user_1', 'customer');
      expect(result).toEqual({
        token: 'signed-jwt-token',
        user: { id: 'user_1', phone: '9876543210', role: 'customer' },
        success: true,
      });
    });

    it('returns 404 when MSG91 reports an expired OTP', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'error', message: 'OTP expired' }),
      });

      await expect(
        otpService.verifyOtpService('+919876543210', '123456')
      ).rejects.toMatchObject({
        message: 'OTP not found or expired',
        statusCode: 404,
      });
    });

    it('returns 400 for an invalid OTP without touching the user record', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'error', message: 'Invalid OTP' }),
      });

      await expect(
        otpService.verifyOtpService('+919876543210', '000000')
      ).rejects.toMatchObject({
        message: 'Invalid OTP',
        statusCode: 400,
      });

      expect(mockUser.findUnique).not.toHaveBeenCalled();
    });

    it('registers a new customer after successful MSG91 verification', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: 'success', message: 'OTP verified success' }),
      });
      mockUser.findUnique.mockResolvedValue(null);
      mockUser.create.mockResolvedValue({
        id: 'user_new',
        phone: '9876543210',
        role: 'customer',
      });

      const result = await otpService.verifyOtpService(
        '+919876543210',
        '123456'
      );

      expect(mockUser.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          phone: '9876543210',
          email: '9876543210@advika.fake',
          role: 'customer',
        }),
      });
      expect(result.user.id).toBe('user_new');
      expect(result.token).toBe('signed-jwt-token');
    });
  });
});
