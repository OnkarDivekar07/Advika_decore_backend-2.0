const otpService = require('./otp.service');
const logger = require('@config/logger');

// POST /api/otp/send-otp
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;
    await otpService.sendOtpService(phone);

    res.sendResponse({
      message: 'OTP sent successfully',
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/verify-otp
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    const { token, user, success } = await otpService.verifyOtpService(
      phone,
      otp
    );

    res.sendResponse({
      message: 'OTP verified successfully',
      data: {
        token,
        user: {
          id: user.id,
          phone: user.phone,
        },
        success,
      },
    });
  } catch (err) {
    next(err);
  }
};
