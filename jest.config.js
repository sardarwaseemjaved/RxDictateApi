module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testEnvironmentOptions: {
    NODE_ENV: 'test',
  },
  // Env defaults have to land before src/config/config.ts validates process.env.
  setupFiles: ['<rootDir>/tests/utils/setupEnv.ts'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  restoreMocks: true,
  coveragePathIgnorePatterns: ['node_modules', 'src/config', 'src/app.ts', 'tests'],
  coverageReporters: ['text', 'lcov', 'clover', 'html'],
};
