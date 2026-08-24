import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'http://localhost:5000';
const TEST_PHONE_NUMBERS = ['+919238971701'];
const HARDCODED_OTP = '123456';
const HARDCODED_PRODUCT_ID = '685fa689bbae72b74378fab4';
const HARDCODED_ADDRESS_ID = '686771fc0eb9883232e7a3dd';

export default function () {
  for (const phone of TEST_PHONE_NUMBERS) {
    console.log(`🔁 Starting test for phone: ${phone}`);

    // Step 1: Send OTP
    const sendOtpRes = http.post(
      `${BASE_URL}/api/otp/send-otp`,
      JSON.stringify({ phone }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    check(sendOtpRes, {
      '✅ OTP sent': (res) => res.status === 200,
    });

    console.log('📨 Send OTP response:', sendOtpRes.json('data'));

    if (sendOtpRes.status !== 200) {
      console.error('❌ OTP send failed', sendOtpRes.body);
      return;
    }

    sleep(1); // Give Redis time to store OTP

    // Step 2: Verify OTP
    const verifyOtpRes = http.post(
      `${BASE_URL}/api/otp/verify-otp`,
      JSON.stringify({ phone, otp: HARDCODED_OTP }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    check(verifyOtpRes, {
      '✅ OTP verified': (res) =>
        res.status === 200 && !!res.json('data.token'),
    });

    console.log('🔐 Verify OTP response:', verifyOtpRes.json('data'));

    if (verifyOtpRes.status !== 200) {
      console.error('❌ OTP verification failed', verifyOtpRes.body);
      return;
    }

    const token = verifyOtpRes.json('data.token');
    const authHeader = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    sleep(1); // Let user session stabilize

    // Step 3: Save Cart
    const cartRes = http.post(
      `${BASE_URL}/api/cart`,
      JSON.stringify({
        cartItems: [
          {
            productId: HARDCODED_PRODUCT_ID,
            quantity: 1,
          },
        ],
      }),
      {
        headers: authHeader,
      }
    );

    check(cartRes, {
      '✅ Cart saved': (res) => res.status === 201,
    });

    console.log('🛒 Cart response:', cartRes.json('data.token'));

    if (cartRes.status !== 201) {
      console.error('❌ Cart save failed', cartRes.body);
      return;
    }

    sleep(1); // Let cart be fully saved

    // Step 4: Create Order
    const orderRes = http.post(
      `${BASE_URL}/api/order`,
      JSON.stringify({ selectedAddressId: HARDCODED_ADDRESS_ID }),
      {
        headers: authHeader,
      }
    );

    check(orderRes, {
      '✅ Status is 201': (res) => res.status === 201,
      '✅ Has orderId': (res) => !!res.json('data.orderId'),
    });

    console.log('🧾 Order response:', orderRes.json('data'));

    if (orderRes.status !== 201) {
      console.error('❌ Order creation failed', orderRes.body);
      return;
    }

    console.log(`🎉 Test finished successfully for phone: ${phone}`);
    sleep(1);
  }
}
