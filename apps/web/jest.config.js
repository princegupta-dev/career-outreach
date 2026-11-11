/** Unit tests for pure browser-side logic (no DOM needed). */
module.exports = {
  testEnvironment: 'node',
  watchman: false,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true } }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testMatch: ['<rootDir>/lib/**/*.spec.ts'],
};
