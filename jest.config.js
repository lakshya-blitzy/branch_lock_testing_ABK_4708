'use strict';

/**
 * Jest configuration for the "Hello, World!" Node.js HTTP server test suite.
 *
 * Rationale for the key options:
 * - testEnvironment 'node': the suite exercises a raw Node HTTP server; no DOM/jsdom is needed.
 * - transform {}: server.js and the test files are plain CommonJS that run natively on Node 22,
 *   so no Babel/TypeScript transform is required. Disabling transforms also prevents Jest from
 *   loading the repository's `.babelrc` (which references `@babel/preset-env`, a package that is
 *   intentionally NOT installed). Leaving `transform` at its default would make Jest attempt
 *   Babel compilation and fail with "Cannot find module '@babel/preset-env'".
 * - testMatch: restricts discovery to the dedicated `tests/` directory so the many unrelated
 *   JavaScript files scattered across this heterogeneous repository are never picked up as tests.
 * - collectCoverageFrom: scopes coverage measurement to `server.js` (the sole unit under test)
 *   so metrics are not diluted by fixtures or unrelated repository artifacts.
 */
module.exports = {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: ['server.js'],
};
