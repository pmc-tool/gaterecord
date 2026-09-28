/**
 * The one jest configuration for the backend (there is deliberately no "jest"
 * key in package.json: jest 29 refuses to start when it finds two).
 *
 * Tests can never reach the shared staging database: test/jest.setup.ts runs
 * before every test file and points DATABASE_URL at an unroutable local port,
 * so a spec that boots AppModule fails fast on 127.0.0.1:1 instead of
 * connecting to whatever backend/.env names. Database suites use their own
 * TEST_DATABASE_URL, must point at a local disposable database, and are skipped
 * when it is unset (see test/db/test-data-source.ts).
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    // test/tsconfig.json extends the app config and also includes test/, which
    // the app config excludes from the build.
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@database/(.*)$': '<rootDir>/src/database/$1',
    '^@gateway/(.*)$': '<rootDir>/src/gateway/$1',
  },
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/database/migrations/**'],
};
