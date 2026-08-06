// jest.config.js
module.exports = {
  testEnvironment: 'node',

  // Mirror package.json's "_moduleAliases" so `require('@modules/...')` etc.
  // resolve the same way under Jest as they do at runtime via module-alias.
  moduleNameMapper: {
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@middlewares/(.*)$': '<rootDir>/src/middlewares/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@routes/(.*)$': '<rootDir>/src/routes/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
  },

  // Populate required env vars before any test file (and the modules it
  // requires) loads — several modules read process.env at require-time.
  setupFiles: ['<rootDir>/tests/setup/env.js'],

  testMatch: [
    '<rootDir>/tests/unit/**/*.test.js',
    '<rootDir>/tests/integration/**/*.test.js',
  ],

  // tests/load-test.js is a k6 script (imports 'k6/http'), not a Jest test —
  // never let Jest try to collect it.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/load-test.js'],

  clearMocks: true,

  collectCoverageFrom: [
    'src/**/*.js',
    '!src/config/**',
    '!src/jobs/workers/**',
  ],
};
