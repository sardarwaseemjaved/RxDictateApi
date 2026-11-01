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

    test("the web app's dev server is a default, so a browser upload works out of the box", () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGINS;
      expect(load().cors.origins).toContain('http://localhost:5173');
    });

    test('setting CORS_ORIGINS replaces the defaults rather than adding to them', () => {
      process.env.NODE_ENV = 'development';
      process.env.CORS_ORIGINS = 'http://localhost:8081';
      expect(load().cors.origins).toEqual(['http://localhost:8081']);
    });
  });

  describe('the OpenAI key', () => {
    /**
     * A doctor finding out mid-consultation that dictation was never
     * configured is worse than a server that refuses to start.
     */
    test('is required when speech to text is openai', () => {
      process.env.STT_PROVIDER = 'openai';
      // Blank, not deleted: dotenv would refill a deleted key from whoever's
      // .env this runs on, and blank is what "no key" looks like anyway.
      process.env.OPENAI_API_KEY = '';
      expect(load).toThrow(/OPENAI_API_KEY is required when STT_PROVIDER or LLM_PROVIDER is openai/);
    });

    test('is required when the extractor is openai', () => {
      process.env.LLM_PROVIDER = 'openai';
      // Blank, not deleted: dotenv would refill a deleted key from whoever's
      // .env this runs on, and blank is what "no key" looks like anyway.
      process.env.OPENAI_API_KEY = '';
      expect(load).toThrow(/OPENAI_API_KEY is required/);
    });

    test('is not required while both providers are off', () => {
      process.env.STT_PROVIDER = 'none';
      process.env.LLM_PROVIDER = 'none';
      // Blank, not deleted: dotenv would refill a deleted key from whoever's
      // .env this runs on, and blank is what "no key" looks like anyway.
      process.env.OPENAI_API_KEY = '';
      expect(load().openai.apiKey).toBeUndefined();
    });

    test('boots with a key, and the models default sensibly', () => {
      process.env.STT_PROVIDER = 'openai';
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_STT_MODEL;

      const config = load();
      expect(config.openai.model).toBe('gpt-4o-mini');
      // Reads code-switched Urdu and English better than whisper-1, which is
      // the whole job here.
      expect(config.openai.sttModel).toBe('gpt-4o-transcribe');
      expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
    });

    test('a key of spaces is still a key, because trimming it is not our call', () => {
      process.env.STT_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = ' ';
      expect(load().openai.apiKey).toBe(' ');
    });

    test('a provider nobody has written is refused', () => {
      process.env.STT_PROVIDER = 'anthropic';
      expect(load).toThrow(/STT_PROVIDER/);
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
