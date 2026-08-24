// PHASE 15 — Security Hardening
//
// Covers @config/sentry's beforeSend scrubbing: the last line of defense
// against an admin/customer Bearer token, session cookie, or raw
// password/OTP ending up in a third-party error-tracking dashboard.
// Exercises the exported `__test` helpers directly rather than going
// through Sentry.init/captureException, so this stays fast and doesn't
// need a real (or mocked) network call to Sentry's ingest endpoint.

const { __test } = require('@config/sentry');
const { redactHeaders, redactSensitiveKeys, scrubEvent } = __test;

describe('sentry config — redactHeaders', () => {
  it('filters known-sensitive headers case-insensitively', () => {
    const result = redactHeaders({
      Authorization: 'Bearer abc.def.ghi',
      Cookie: 'session=xyz',
      'X-Api-Key': 'super-secret-key',
      'Content-Type': 'application/json',
    });

    expect(result.Authorization).toBe('[Filtered]');
    expect(result.Cookie).toBe('[Filtered]');
    expect(result['X-Api-Key']).toBe('[Filtered]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('passes through non-object input unchanged', () => {
    expect(redactHeaders(null)).toBeNull();
    expect(redactHeaders(undefined)).toBeUndefined();
  });
});

describe('sentry config — redactSensitiveKeys', () => {
  it('redacts top-level fields whose name looks like a secret', () => {
    const result = redactSensitiveKeys({
      email: 'admin@example.com',
      password: 'hunter2',
      token: 'abc.def.ghi',
      otpCode: '123456',
      newPassword: 'hunter3',
      accessToken: 'xyz',
    });

    expect(result.email).toBe('admin@example.com');
    expect(result.password).toBe('[Filtered]');
    expect(result.token).toBe('[Filtered]');
    expect(result.otpCode).toBe('[Filtered]');
    expect(result.newPassword).toBe('[Filtered]');
    expect(result.accessToken).toBe('[Filtered]');
  });

  it('redacts sensitive fields nested one level deep', () => {
    const result = redactSensitiveKeys({
      user: { name: 'Admin', password: 'hunter2' },
    });

    expect(result.user.name).toBe('Admin');
    expect(result.user.password).toBe('[Filtered]');
  });

  it('leaves non-sensitive nested data intact', () => {
    const result = redactSensitiveKeys({
      order: { id: '1', total: 499, status: 'confirmed' },
    });

    expect(result).toEqual({
      order: { id: '1', total: 499, status: 'confirmed' },
    });
  });
});

describe('sentry config — scrubEvent', () => {
  it('scrubs request headers, cookies, and body on a full event', () => {
    const event = {
      request: {
        headers: { Authorization: 'Bearer secret-token', Accept: '*/*' },
        cookies: { session: 'xyz' },
        data: { email: 'admin@example.com', password: 'hunter2' },
      },
      breadcrumbs: [
        {
          category: 'http',
          data: { url: '/api/admin/login', password: 'hunter2' },
        },
      ],
    };

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request.headers.Authorization).toBe('[Filtered]');
    expect(scrubbed.request.headers.Accept).toBe('*/*');
    expect(scrubbed.request.cookies).toBe('[Filtered]');
    expect(scrubbed.request.data.password).toBe('[Filtered]');
    expect(scrubbed.request.data.email).toBe('admin@example.com');
    expect(scrubbed.breadcrumbs[0].data.password).toBe('[Filtered]');
  });

  it('is a no-op on an event with no request/breadcrumbs', () => {
    const event = { message: 'Something went wrong' };
    expect(scrubEvent(event)).toEqual(event);
  });
});
