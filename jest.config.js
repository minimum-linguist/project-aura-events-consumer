module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  passWithNoTests: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/dist/**',
    '!jest.config.js',
    '!__tests__/**',
    '!scripts/**',
  ],
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 55,
      lines: 80,
      statements: 80,
    },
  },
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
};
