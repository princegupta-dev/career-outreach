/** Integration tests: require PostgreSQL + Redis (see README → Tests). */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  watchman: false,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup/env.ts'],
  testTimeout: 60000,
};
