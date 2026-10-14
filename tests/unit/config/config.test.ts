/**
 * config.ts does its work at module load, so each case here resets the module
 * registry and requires it again with a different environment.
 */
describe('Config', () => {
  const original = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...original };
  });

  afterAll(() => {
    process.env = original;
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const load = () => require('../../../src/config/config').default as typeof import('../../../src/config/config').default;

  describe('the fixed sign-in code', () => {
    test('is off unless it is set', () => {
      delete process.env.OTP_FIXED_CODE;
      expect(load().otp.fixedCode).toBeUndefined();
    });

    test('is picked up outside production', () => {
      process.env.NODE_ENV = 'development';
      process.env.OTP_FIXED_CODE = '123456';
      expect(load().otp.fixedCode).toBe('123456');
    });

    /**
     * The one that matters. A fixed code is a complete bypass of
     * authentication, so production must not be able to turn it on by
     * accident, a copied .env, or a stray variable on a deployment.
     */
    test('is ignored in production, however it is set', () => {
      process.env.NODE_ENV = 'production';
      process.env.OTP_FIXED_CODE = '123456';
      process.env.CORS_ORIGINS = 'https://app.example.com';

      const config = load();

      expect(config.isProduction).toBe(true);
      expect(config.otp.fixedCode).toBeUndefined();
      // The code is not handed back in a response there either.
      expect(config.otp.exposeInResponse).toBe(false);
    });

    test('refuses anything that is not six digits', () => {
      process.env.OTP_FIXED_CODE = '12345';
      expect(load).toThrow(/OTP_FIXED_CODE: must be six digits/);
    });

    test('treats an empty value as unset, so a commented-out line is fine', () => {
      process.env.OTP_FIXED_CODE = '';
      expect(load().otp.fixedCode).toBeUndefined();
    });
  });

  describe('CORS', () => {
    test('production refuses to boot with no origins', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = '';
      expect(load).toThrow(/CORS_ORIGINS must list at least one origin/);
    });

    test('a request with no Origin is a native app, so dev gets sensible defaults', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGINS;
      expect(load().cors.origins).toContain('http://localhost:8081');
    });
  });

  describe('required variables', () => {
    /**
     * Blank rather than deleted: dotenv does not overwrite a key that is
     * already in process.env, but it would happily supply a deleted one from
     * the developer's own .env, which would make this test pass or fail
     * depending on whose machine it runs on.
     */
    test('a blank JWT_SECRET fails the boot by name', () => {
      process.env.JWT_SECRET = '';
      expect(load).toThrow(/JWT_SECRET/);
    });

    test('a short JWT_SECRET is refused', () => {
      process.env.JWT_SECRET = 'tooshort';
      expect(load).toThrow(/JWT_SECRET/);
    });
  });
});
