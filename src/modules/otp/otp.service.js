const redis = require('@config/redis');
const prisma = require('@config/prisma');
const twilio = require('twilio');
const generateToken = require('@utils/generateToken');
const CustomError = require('@utils/customError');
const formatNumber = require('@utils/formatNumber');

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

exports.sendOtpService = async (phone) => {
 const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const key = `otp:${phone}`;

  await redis.set(key, otp, 'EX', 300); // EX 300 = expires in 5 min

  await client.messages.create({
    body: `Your Advika OTP is ${otp}. Do not share it with anyone.`,
    from: process.env.TWILIO_PHONE,
    to: phone,
  });
};

exports.verifyOtpService = async (phone, otp) => {
  formatNumber(phone);
  const key = `otp:${phone}`;
  const storedOtp = await redis.get(key);
  if (!storedOtp) throw new CustomError('OTP not found or expired', 404);
  if (storedOtp !== otp) throw new CustomError('Invalid OTP', 400);
  await redis.del(key); // delete used OTP
  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone,
        name: 'New User',
        email: `${phone}@advika.fake`,
        password: '',
        role: 'customer',
      },
    });
  }

  const token = generateToken(user.id, user.role);
  return { token, user, success: true };
};
