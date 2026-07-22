'use strict';

/**
 * Coverage preload for the direct-execution (black-box) run of `server.js`.
 *
 * This module is injected via `node --require <this file> server.js` by
 * `tests/helpers/collect-direct-run-coverage.js`. Because it is loaded with
 * `-r` (a *preload*) rather than as the entry point, `server.js` REMAINS the
 * process main module — so `require.main === module` stays TRUE inside
 * `server.js` and its `server.listen(...)` startup branch (the exact lines
 * that Jest's in-process `require` can never reach) executes for real under V8
 * coverage.
 *
 * `server.js` intentionally installs no signal handlers (per the AAP's
 * minimal-refactor constraint). `NODE_V8_COVERAGE` only flushes coverage to
 * disk on a *clean* process exit, and a bare SIGTERM would terminate the long
 * lived child WITHOUT flushing. This preload therefore installs its own
 * SIGTERM/SIGINT handlers that explicitly persist the accumulated coverage via
 * `v8.takeCoverage()` and then `exit(0)`, guaranteeing the coverage file is on
 * disk before the process dies.
 *
 * This is a TEST-ONLY helper: production `node server.js` runs never load it.
 */
const v8 = require('node:v8');

function flushAndExit() {
  try {
    // Persist the V8 coverage collected so far into the NODE_V8_COVERAGE
    // directory so the parent test can read and merge it.
    v8.takeCoverage();
  } catch (err) {
    // Best-effort: surface a diagnostic but still exit cleanly so the parent
    // launcher is never left waiting on a stuck child.
    process.stderr.write(`coverage-preload: v8.takeCoverage() failed: ${err && err.message}\n`);
  }
  process.exit(0);
}

process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);
