/**
 * Jest configuration for the `hello_world` project's `server.js` test suite.
 *
 * This file is the SINGLE source of Jest configuration for the project; the
 * sibling `package.json` intentionally contains no `jest` block (AAP Section
 * 0.5.1 — "Use this file OR the package.json jest block, not both").
 *
 * Rationale for each option (see Technical Specification Sections 0.5.3 / 0.7.1):
 *
 * - testEnvironment: 'node'
 *     `server.js` is a plain Node HTTP server with no DOM/browser dependency,
 *     so the lightweight Node test environment is correct (and faster than the
 *     jsdom environment).
 *
 * - testMatch: ['**\/tests\/**\/*.test.js']   (slashes escaped in this comment
 *     only, so the '*' + '/' pairs do not prematurely close the block comment)
 *     Restricts test discovery to the suites authored under `tests/`
 *     (`tests/server.test.js` and `tests/server.lifecycle.test.js`). This
 *     scoping is essential in THIS repository: the root is a heterogeneous
 *     dumping ground of ~180 files, including multi-megabyte fixtures
 *     (`100K.js`, `300K.js`, `700K.js`) and unrelated sources (`app.js`,
 *     `benchmark.js`, `runner.js`). A broader pattern would attempt to execute
 *     those unrelated files as tests.
 *
 * - transform: {}
 *     Disables Jest's default `babel-jest` transform. Both `server.js` and the
 *     test files are CommonJS and run natively on Node 22, so no transpilation
 *     is wanted — an empty transform map is the canonical Jest way to express
 *     "no transform" (it removes the default babel-jest step rather than adding
 *     one). It is also REQUIRED here: the repository ships a `.babelrc`
 *     referencing `@babel/preset-env`, a preset that is intentionally NOT a
 *     dependency. With the default transform active, `babel-jest` auto-loads
 *     that `.babelrc` and the run aborts with
 *     "Cannot find module '@babel/preset-env'" (verified empirically). An empty
 *     transform map bypasses Babel entirely so the suite runs green.
 *
 * - collectCoverageFrom: ['server.js']
 *     Scopes coverage instrumentation to the single file under test so the
 *     unrelated root artifacts above never dilute or bloat the reported
 *     metrics. Coverage remains opt-in (via `--coverage` / `npm run
 *     test:coverage`) and is deliberately NOT collected on a plain `npm test`,
 *     keeping the default run fast.
 *
 * - coverageThreshold: 100% for ./server.js
 *     Enforces the AAP coverage target (Section 0.7.1): statements, branches,
 *     functions, and lines must all reach 100% for `server.js`. The in-process
 *     `require('../server')` suite covers the request handler, but can never
 *     reach the `require.main === module` startup branch (under Jest the test
 *     file, not the required module, is always `require.main`). That branch is
 *     exercised for real by the black-box child in
 *     `tests/server.lifecycle.test.js`, whose genuine V8 coverage is merged
 *     into Jest's in-process Istanbul data by
 *     `tests/helpers/collect-direct-run-coverage.js` — so the gate reaches 100%
 *     honestly (verified empirically: `npm run test:coverage` exits 0). The
 *     threshold is only enforced when coverage is collected, so a plain
 *     `npm test` is unaffected by it.
 *
 * - maxWorkers: 1
 *     Serializes execution so the lifecycle suite's fixed-port-3000 work (the
 *     black-box `node server.js` child and the coverage child) can never
 *     contend for the port with a parallel worker, guaranteeing EADDRINUSE-free,
 *     deterministic runs regardless of CLI flags (AAP Section 0.9.1).
 */

/** @type {import('jest').Config} */
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
