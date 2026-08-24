const {
  calculateDeliveryCharge,
  calculateDiscount,
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_CHARGE,
} = require('@constants/pricing');

describe('calculateDeliveryCharge', () => {
  it('charges the flat delivery fee below the free-delivery threshold', () => {
    expect(calculateDeliveryCharge(0)).toBe(DELIVERY_CHARGE);
    expect(calculateDeliveryCharge(FREE_DELIVERY_THRESHOLD - 1)).toBe(
      DELIVERY_CHARGE
    );
  });

  it('waives the delivery fee at and above the threshold', () => {
    expect(calculateDeliveryCharge(FREE_DELIVERY_THRESHOLD)).toBe(0);
    expect(calculateDeliveryCharge(FREE_DELIVERY_THRESHOLD + 1)).toBe(0);
  });
});

// Discount/coupon placeholder architecture — see src/constants/pricing.js.
// No Coupon model exists yet, so this documents the two behaviors that
// actually matter today: the no-coupon path stays silently free (every
// existing cart/order), and any real code is rejected rather than quietly
// honored, so nothing downstream can be tricked into granting a discount
// that was never actually validated against anything.
describe('calculateDiscount', () => {
  it('resolves to 0 without throwing when no coupon code is given', () => {
    expect(calculateDiscount(1000, undefined)).toBe(0);
    expect(calculateDiscount(1000, null)).toBe(0);
    expect(calculateDiscount(1000, '')).toBe(0);
  });

  it('rejects any non-empty coupon code (no coupons exist yet)', () => {
    expect(() => calculateDiscount(1000, 'SAVE10')).toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
  });
});
