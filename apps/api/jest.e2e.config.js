/** End-to-end workflow tests: require PostgreSQL + Redis. */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  watchman: false,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  testTimeout: 120000,
};
