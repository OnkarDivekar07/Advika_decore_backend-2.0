const redis = require('@config/redis');
const prisma = require('@config/prisma');
const twilio = require('twilio');
const generateToken = require('@utils/generateToken');
const CustomError = require('@utils/customError');
const formatNumber = require('@utils/formatNumber');

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

exports.sendOtpService = async (phone) => {
 const otp = Math.floor(100000 + Math.random() * 900000).toString();
  // Normalize to the DB's bare 10-digit format so the Redis key here and
  // the one verifyOtpService looks up under always match, and so it lines
  // up with how the phone is stored/looked-up in Postgres/Mongo below.
  const normalizedPhone = formatNumber(phone);
  const key = `otp:${normalizedPhone}`;

  await redis.set(key, otp, 'EX', 300); // EX 300 = expires in 5 min

  await client.messages.create({
    body: `Your Advika OTP is ${otp}. Do not share it with anyone.`,
    from: process.env.TWILIO_PHONE,
    // Twilio needs the full E.164 number (with country code) the client
    // sent, not the normalized/DB form — deliberately using raw `phone`.
    to: phone,
  });
};

exports.verifyOtpService = async (phone, otp) => {
  const normalizedPhone = formatNumber(phone);
  const key = `otp:${normalizedPhone}`;
  const storedOtp = await redis.get(key);
  if (!storedOtp) throw new CustomError('OTP not found or expired', 404);
  if (storedOtp !== otp) throw new CustomError('Invalid OTP', 400);
  await redis.del(key); // delete used OTP
  let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone: normalizedPhone,
        name: 'New User',
        email: `${normalizedPhone}@advika.fake`,
        password: '',
        role: 'customer',
      },
    });
  }

  const token = generateToken(user.id, user.role);
  return { token, user, success: true };
};
