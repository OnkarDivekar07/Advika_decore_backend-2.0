const formatNumber = require('@utils/formatNumber');

describe('formatNumber (phone normalization)', () => {
  it('strips a "+91" country code down to the bare 10-digit number', () => {
    expect(formatNumber('+919876543210')).toBe('9876543210');
  });

  it('strips a "91" country code with no "+" down to 10 digits', () => {
    expect(formatNumber('919876543210')).toBe('9876543210');
  });

  it('strips whitespace between the country code and the number', () => {
    expect(formatNumber('+91 9876543210')).toBe('9876543210');
  });

  it('leaves an already-bare 10-digit number unchanged', () => {
    expect(formatNumber('9876543210')).toBe('9876543210');
  });

  it('strips other punctuation (dashes, parens)', () => {
    expect(formatNumber('+91-987-654-3210')).toBe('9876543210');
  });
});
