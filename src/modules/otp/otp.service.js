const prisma = require('@config/prisma');
const generateToken = require('@utils/generateToken');
const CustomError = require('@utils/customError');
const formatNumber = require('@utils/formatNumber');

const MSG91_SEND_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const MSG91_VERIFY_OTP_URL = 'https://control.msg91.com/api/v5/otp/verify';

const getMsg91Config = () => {
  const authKey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authKey || !templateId) {
    throw new Error(
      'MSG91 is not configured. Set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.'
    );
  }

  return { authKey, templateId };
};

const toIndianE164 = (phone) => `91${formatNumber(phone)}`;

const parseMsg91Response = async (response) => {
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  return { data, text };
};

exports.sendOtpService = async (phone) => {
  const { authKey, templateId } = getMsg91Config();
  const mobile = toIndianE164(phone);

  const url = new URL(MSG91_SEND_OTP_URL);
  url.searchParams.set('template_id', templateId);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('authkey', authKey);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  } catch (error) {
    throw new CustomError(`MSG91 OTP service unavailable: ${error.message}`, 502);
  }

  const { data } = await parseMsg91Response(response);

  if (!response.ok || data.type !== 'success') {
    const message =
      data.message || data.error || 'MSG91 failed to send OTP';
    throw new CustomError(`Unable to send OTP: ${message}`, 502);
  }
};

// Talks to MSG91's verify endpoint only — no user lookup/creation/login
// side effects. Split out of verifyOtpService so any flow that needs "is
// this OTP actually correct for this phone?" (e.g. the user module's
// change-mobile-number flow, which must NOT log the caller into whichever
// account the new phone happens to belong to) can reuse the exact same
// MSG91 call/parsing/error-shaping instead of re-implementing it.
// Throws a CustomError (404 for expired/not-found, 400 for invalid) on
// failure; resolves with nothing on success.
const verifyOtpWithProvider = async (phone, otp) => {
  const { authKey } = getMsg91Config();
  const mobile = toIndianE164(phone);

  const url = new URL(MSG91_VERIFY_OTP_URL);
  url.searchParams.set('otp', otp);
  url.searchParams.set('mobile', mobile);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        authkey: authKey,
      },
    });
  } catch (error) {
    throw new CustomError(
      `MSG91 OTP verification service unavailable: ${error.message}`,
      502
    );
  }

  const { data } = await parseMsg91Response(response);
  const verified = response.ok && data.type === 'success';

  if (!verified) {
    const message = data.message || data.error || 'Invalid OTP';
    const normalizedMessage = /expired/i.test(message)
      ? 'OTP not found or expired'
      : 'Invalid OTP';

    throw new CustomError(normalizedMessage, /expired/i.test(message) ? 404 : 400);
  }
};

exports.verifyOtpWithProvider = verifyOtpWithProvider;

exports.verifyOtpService = async (phone, otp) => {
  await verifyOtpWithProvider(phone, otp);

  const normalizedPhone = formatNumber(phone);
  let user = await prisma.user.findUnique({
    where: { phone: normalizedPhone },
  });

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
