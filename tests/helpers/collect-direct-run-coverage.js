'use strict';

/**
 * Direct-execution coverage collector for `server.js`.
 *
 * Jest's in-process `require('../server')` can exercise the request handler,
 * but it can NEVER execute the `require.main === module` startup branch: the
 * Jest runtime always reports the test file (not a required module) as
 * `require.main`, so that guard is structurally unreachable in-process. Those
 * startup lines are therefore the only coverage gap for `server.js`.
 *
 * To close the gap with REAL execution (no `istanbul-ignore`, no fabricated
 * hits), this helper launches `server.js` as a genuine child process with a
 * coverage preload, lets its startup branch run, captures V8 coverage, and
 * merges ONLY the lines the child genuinely executed back into Jest's
 * in-process Istanbul coverage object for `server.js`.
 *
 * It is a no-op unless Jest is collecting coverage (`global.__coverage__` is
 * only defined under `jest --coverage`), so a plain `npm test` run neither
 * spawns a child nor binds the fixed port 3000 here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'server.js');
const PRELOAD_PATH = path.join(__dirname, 'coverage-preload.js');
const STARTUP_LOG = 'Server running at http://127.0.0.1:3000/';

// Bounded timeouts keep the collector from ever hanging the suite.
const READY_WATCHDOG_MS = 8000; // must stay below the lifecycle Jest timeout
const SIGKILL_FALLBACK_MS = 2000; // escalate if a SIGTERM does not settle
const MAX_OUTPUT_BYTES = 64 * 1024; // cap child stdout retained in memory

/**
 * Spawn `node -r coverage-preload.js server.js` as a real child so the
 * `require.main === module` startup branch executes and is measured by V8
 * coverage. Resolves `true` once the startup line is observed and the child
 * has been reaped, `false` on any failure. The child is always terminated.
 *
 * @param {string} covDir - NODE_V8_COVERAGE output directory for this run.
 * @returns {Promise<boolean>}
 */
function runInstrumentedChild(covDir) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let sawStartup = false;
    let watchdog;
    let killTimer;

    const child = spawn(process.execPath, ['-r', PRELOAD_PATH, 'server.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_V8_COVERAGE: covDir },
    });

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      child.stdout.removeAllListeners();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (err) {
          // Child already exited; nothing to reap.
        }
      }
      resolve(ok);
    };

    watchdog = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        // Child already exited; nothing to reap.
      }
      finish(false);
    }, READY_WATCHDOG_MS);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
      if (!sawStartup && stdout.includes(STARTUP_LOG)) {
        sawStartup = true;
        // Ask the preload to flush coverage and exit cleanly; escalate to
        // SIGKILL only if the child does not settle within the fallback window.
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (err) {
            // Child already exited; nothing to reap.
          }
        }, SIGKILL_FALLBACK_MS);
      }
    });
    child.on('error', () => finish(false));
    child.on('exit', () => finish(sawStartup));
  });
}

/**
 * Read every V8 coverage entry for `server.js` written into `covDir`. Multiple
 * files may exist (one from `v8.takeCoverage()`, one from clean exit); all
 * matching entries are returned so their executed ranges can be unioned.
 *
 * @param {string} covDir
 * @returns {Array<object>} V8 script-coverage entries for server.js
 */
function readServerV8Entries(covDir) {
  const entries = [];
  for (const file of fs.readdirSync(covDir)) {
    if (!file.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(covDir, file), 'utf8'));
    } catch (err) {
      continue; // skip a partially written coverage file
    }
    for (const entry of data.result || []) {
      if (!entry.url || entry.url.includes('node_modules')) continue;
      let resolved = entry.url;
      if (resolved.startsWith('file://')) {
        try {
          resolved = fileURLToPath(resolved);
        } catch (err) {
          // Fall back to the raw url string for comparison.
        }
      }
      if (resolved === SERVER_PATH) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Convert the child's V8 coverage entries for `server.js` into a
 * `{ lineNumber: maxHitCount }` map using v8-to-istanbul, unioning across all
 * entries so a partial flush plus the clean-exit flush together give the full
 * picture.
 *
 * @param {Array<object>} entries
 * @returns {Promise<Record<number, number>>}
 */
async function unionExecutedLines(entries) {
  const v8toIstanbul = require('v8-to-istanbul');
  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  const lines = {};
  for (const entry of entries) {
    const converter = v8toIstanbul(SERVER_PATH, 0, { source });
    await converter.load();
    converter.applyCoverage(entry.functions);
    const fileCov = converter.toIstanbul()[SERVER_PATH];
    for (const id of Object.keys(fileCov.statementMap)) {
      const loc = fileCov.statementMap[id];
      const hits = fileCov.s[id];
      for (let ln = loc.start.line; ln <= loc.end.line; ln += 1) {
        lines[ln] = Math.max(lines[ln] || 0, hits);
      }
    }
  }
  return lines;
}

/**
 * True only if EVERY source line spanned by `loc` was executed by the child.
 * This location-driven test means the merge reflects real execution and never
 * over-counts, and it adapts automatically if `server.js` changes shape.
 *
 * @param {{start:{line:number},end:{line:number}}|null|undefined} loc
 * @param {Record<number, number>} executedLines
 * @returns {boolean}
 */
function locationFullyExecuted(loc, executedLines) {
  if (!loc || !loc.start || loc.start.line == null || !loc.end || loc.end.line == null) {
    return false;
  }
  for (let ln = loc.start.line; ln <= loc.end.line; ln += 1) {
    if (!(executedLines[ln] > 0)) return false;
  }
  return true;
}

/**
 * Merge the child's genuinely-executed lines into Jest's in-process Istanbul
 * coverage for `server.js`. Only statements/functions/branches whose source
 * location was fully executed in the child are marked covered.
 *
 * @param {object} fileCov - Istanbul FileCoverage data for server.js.
 * @param {Record<number, number>} executedLines
 */
function mergeExecutedLines(fileCov, executedLines) {
  for (const id of Object.keys(fileCov.statementMap)) {
    if (!fileCov.s[id] && locationFullyExecuted(fileCov.statementMap[id], executedLines)) {
      fileCov.s[id] = 1;
    }
  }
  for (const id of Object.keys(fileCov.fnMap)) {
    const fn = fileCov.fnMap[id];
    const covered =
      locationFullyExecuted(fn.loc, executedLines) ||
      locationFullyExecuted(fn.decl, executedLines);
    if (!fileCov.f[id] && covered) {
      fileCov.f[id] = 1;
    }
  }
  for (const id of Object.keys(fileCov.branchMap)) {
    const locations = fileCov.branchMap[id].locations || [];
    locations.forEach((loc, index) => {
      if (!fileCov.b[id][index] && locationFullyExecuted(loc, executedLines)) {
        fileCov.b[id][index] = 1;
      }
    });
  }
}

/**
 * Public entry point invoked from the lifecycle suite's `afterAll`. Spawns the
 * instrumented child, captures its real execution of the `server.js` startup
 * branch, and merges those lines into Jest's coverage object. No-op unless
 * coverage is being collected.
 *
 * @returns {Promise<void>}
 */
async function collectDirectRunCoverage() {
  const coverage = global.__coverage__;
  if (!coverage) return;

  const covPath = Object.keys(coverage).find(
    (key) => key === SERVER_PATH || key.endsWith(`${path.sep}server.js`)
  );
  if (!covPath) return;

  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-direct-run-cov-'));
  try {
    const ready = await runInstrumentedChild(covDir);
    if (!ready) {
      throw new Error(
        'direct-run coverage child did not report the startup line; ' +
          'cannot merge direct-execution coverage for server.js'
      );
    }
    const entries = readServerV8Entries(covDir);
    if (entries.length === 0) {
      throw new Error('no V8 coverage was captured for server.js from the direct-run child');
    }
    const executedLines = await unionExecutedLines(entries);
    mergeExecutedLines(coverage[covPath], executedLines);
  } finally {
    fs.rmSync(covDir, { recursive: true, force: true });
  }
}

module.exports = { collectDirectRunCoverage };
