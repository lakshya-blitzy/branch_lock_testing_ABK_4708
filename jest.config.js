/**
 * Jest configuration for the hello_world project's `server.js` test suite.
 *
 * Rationale for each option (see Technical Specification Section 0.5.3 / 0.7.1):
 *
 * - testEnvironment: 'node'
 *     `server.js` is a plain Node HTTP server with no DOM/browser dependency,
 *     so the lightweight Node test environment is correct (and faster than jsdom).
 *
 * - testMatch: ['**\/tests/**\/*.test.js']
 *     Discovers the suites authored for the server under `tests/`
 *     (`tests/server.test.js` and `tests/server.lifecycle.test.js`).
 *
 * - transform: {}
 *     Disables Jest's default `babel-jest` transform. Both `server.js` and the
 *     test files are CommonJS and run natively on Node 22, so no transpilation
 *     is required. Leaving the default transform enabled would cause `babel-jest`
 *     to auto-load the repository's `.babelrc` (which references
 *     `@babel/preset-env`); that preset is intentionally NOT a dependency of this
 *     project, so an empty transform map is required for the suite to run.
 *
 * - collectCoverageFrom: ['server.js']
 *     Scopes coverage measurement to the single file under test so that unrelated
 *     repository artifacts do not dilute the reported metrics (used by
 *     `npm run test:coverage`).
 *
 * - coverageThreshold: 100% for server.js
 *     Enforces the AAP's coverage target (Section 0.7.1): statements, branches,
 *     functions, and lines must all reach 100% for `server.js`, so the suite
 *     fails if the response handler OR the direct-execution startup branch ever
 *     regresses below full coverage. The startup branch is exercised for real by
 *     the black-box child process in `tests/server.lifecycle.test.js`, whose
 *     genuine V8 coverage is merged in via `tests/helpers/collect-direct-run-coverage.js`.
 *
 * - maxWorkers: 1
 *     Serializes test execution so the lifecycle suite's fixed-port-3000 work
 *     (the black-box `node server.js` child and the coverage child) can never
 *     contend for the port with another worker, guaranteeing EADDRINUSE-free,
 *     deterministic runs regardless of CLI flags (AAP Section 0.9.1).
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  transform: {},
  collectCoverageFrom: ['server.js'],
  coverageThreshold: {
    './server.js': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  maxWorkers: 1,
};
