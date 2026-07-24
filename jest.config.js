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
 *     file, not the required module, is always `require.main`), so that branch
 *     alone would sit at ~81.81% statements / 50% branches / 50% functions.
 *     `tests/server.lifecycle.test.js` closes the gap by MEASURING that branch
 *     from a genuine `node server.js` child: it launches the file directly under
 *     `NODE_V8_COVERAGE` (server.js stays `require.main`, so the guard is TRUE
 *     and its `server.listen(...)` + startup-log callback run for real), then
 *     merges ONLY the ranges the child genuinely executed into Jest's in-process
 *     `global.__coverage__` for `server.js`. The merge is a real V8 measurement,
 *     not a fabricated marking: every counter it raises is backed by a `count>0`
 *     V8 range, it never marks code the child did not run, and it never
 *     downgrades an in-process hit. The child is stopped via a tiny ephemeral
 *     preload (written outside the repo) that turns SIGTERM into a clean
 *     `process.exit(0)` so Node's `NODE_V8_COVERAGE` exit hook writes the full
 *     coverage dump; because that OS-level flush is best-effort, the parent uses
 *     a small bounded retry and accepts the first attempt yielding real ranges.
 *     It uses ONLY Node built-ins (`fs`, `os`, `path`, `child_process`, `url`)
 *     and the public `global.__coverage__` map — no committed helper file and no
 *     third-party/transitive dependency such as v8-to-istanbul. It is
 *     evidence-gated (it runs only after the black-box test proves the startup
 *     line was printed) and a no-op when coverage is not being collected, so the
 *     gate reaches 100% honestly: a real startup regression makes the child print
 *     no startup line, the merge throws before running, and coverage stays below
 *     100%. The threshold is only enforced when coverage is collected, so a plain
 *     `npm test` is unaffected.
 *
 * - maxWorkers: 1
 *     Serializes execution so the lifecycle suite's fixed-port-3000 work (the
 *     black-box `node server.js` child) can never contend for the port with a
 *     parallel worker, guaranteeing EADDRINUSE-free, deterministic runs
 *     regardless of CLI flags (AAP Section 0.9.1).
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
