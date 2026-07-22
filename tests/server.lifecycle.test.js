'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const request = require('supertest');
const server = require('../server');
const { collectDirectRunCoverage } = require('./helpers/collect-direct-run-coverage');

const EXPECTED_BODY = 'Hello, World!\n';
const STARTUP_LOG = 'Server running at http://127.0.0.1:3000/';

// Bounded timeouts keep every asynchronous path from hanging the suite. Each is
// comfortably below the enclosing Jest per-test timeout so a specific, useful
// error surfaces before Jest's generic timeout would fire.
const READY_WATCHDOG_MS = 8000;
const SIGKILL_FALLBACK_MS = 2000;
const SOCKET_TIMEOUT_MS = 6000;
const FOLLOWUP_REQUEST_TIMEOUT_MS = 6000;
const MAX_OUTPUT_BYTES = 64 * 1024;

// Release the shared, import-based server instance after every test. Guarded so
// an unconditional close on a non-listening server never throws
// ERR_SERVER_NOT_RUNNING.
afterEach((done) => {
  if (server.listening) {
    server.close(done);
  } else {
    done();
  }
});

describe('server.js lifecycle (F-001 listener)', () => {
  test('listen(0) binds an ephemeral port, then close() releases it', (done) => {
    expect(server.listening).toBe(false);
    server.listen(0, '127.0.0.1', () => {
      expect(server.listening).toBe(true);
      const address = server.address();
      expect(typeof address.port).toBe('number');
      expect(address.port).toBeGreaterThan(0);
      server.close(() => {
        expect(server.listening).toBe(false);
        done();
      });
    });
  });

  test('the exported server itself receives EADDRINUSE when binding an occupied port', (done) => {
    // A DISTINCT blocker occupies an ephemeral port first. The previous version
    // of this test made a throwaway "intruder" server receive the error while
    // the exported server bound successfully — a false positive that never
    // exercised the subject under test. Here the EXPORTED server is the one
    // that attempts the already-occupied port and must emit EADDRINUSE.
    const blocker = net.createServer();
    let settled = false;
    let watchdog;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      server.removeListener('error', onServerError);
      // Recover both resources on every path. The exported server does not
      // become "listening" when its bind fails, but guard anyway; always close
      // the blocker so the ephemeral port is released for later tests.
      const closeBlocker = () => blocker.close(() => done(err));
      if (server.listening) {
        server.close(closeBlocker);
      } else {
        closeBlocker();
      }
    };

    function onServerError(err) {
      try {
        expect(err.code).toBe('EADDRINUSE');
        finish();
      } catch (assertionErr) {
        finish(assertionErr);
      }
    }

    watchdog = setTimeout(
      () => finish(new Error('exported server did not emit EADDRINUSE within the deadline')),
      READY_WATCHDOG_MS
    );

    blocker.once('error', (err) =>
      finish(err instanceof Error ? err : new Error(`blocker failed: ${err}`))
    );
    blocker.listen(0, '127.0.0.1', () => {
      const occupiedPort = blocker.address().port;
      server.once('error', onServerError);
      server.listen(occupiedPort, '127.0.0.1');
    });
  });
});

describe('server.js error handling (Node default behavior)', () => {
  test('malformed request yields 400; a subsequent valid request still returns 200', (done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      let settled = false;
      let raw = '';
      let watchdog;

      const socket = net.connect(port, '127.0.0.1', () => {
        // Content-Length is not a number: an objectively malformed request that
        // Node's HTTP parser rejects with its default 400 response.
        socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: not-a-number\r\n\r\n');
      });

      // Single settle path: exactly one done(), all listeners removed, socket
      // destroyed, watchdog cleared — regardless of which event (error, timeout,
      // or close) settles first. Node emits 'error' -> 'close' for this case, so
      // without this guard 'close' could call done() a second time (C2-04).
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        socket.removeAllListeners();
        socket.destroy();
        done(err);
      };

      watchdog = setTimeout(
        () => finish(new Error('malformed-request test timed out awaiting a response')),
        READY_WATCHDOG_MS
      );

      socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
        finish(new Error('raw socket timed out awaiting the 400 response'))
      );
      socket.once('error', (err) => finish(err));
      socket.on('data', (chunk) => {
        raw += chunk.toString();
        if (raw.length > MAX_OUTPUT_BYTES) {
          // Bound the buffer: a well-behaved 400 response is tiny, so anything
          // larger is anomalous and must not grow unbounded.
          finish(new Error('malformed-request response exceeded the size cap'));
        }
      });
      socket.once('close', () => {
        if (settled) return;
        try {
          expect(raw).toMatch(/^HTTP\/1\.1 400 /);
        } catch (assertionErr) {
          finish(assertionErr);
          return;
        }
        // The process must survive the malformed request: a subsequent valid
        // request over the exported server still returns 200 / the fixed body.
        request(server)
          .get('/')
          .timeout({ deadline: FOLLOWUP_REQUEST_TIMEOUT_MS })
          .then((res) => {
            try {
              expect(res.statusCode).toBe(200);
              expect(res.text).toBe(EXPECTED_BODY);
              finish();
            } catch (assertionErr) {
              finish(assertionErr);
            }
          })
          .catch((err) => finish(err));
      });
    });
  });
});

describe('server.js startup log (F-003, black-box direct execution)', () => {
  test('running "node server.js" prints the exact startup line, is reaped, and frees port 3000', (done) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let sawStartup = false;
    let watchdog;
    let killTimer;

    const capture = (buffer, chunk) =>
      buffer.length < MAX_OUTPUT_BYTES ? buffer + chunk.toString() : buffer;

    // Centralized cleanup runs on every path (success, spawn error, early exit,
    // assertion failure, watchdog timeout): clears timers, removes listeners,
    // and guarantees the child is terminated and reaped so no process or port
    // leaks past the test (C2-05).
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (killErr) {
          // Child already exited; nothing to reap.
        }
      }
      done(err);
    };

    // Watchdog well below the 15s Jest timeout so a hung child is force-killed
    // and reaped rather than leaking (C2-05).
    watchdog = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (killErr) {
        // Child already exited; nothing to reap.
      }
      finish(
        new Error(
          'startup watchdog fired before the exact startup line was observed; ' +
            `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
        )
      );
    }, READY_WATCHDOG_MS);

    child.stdout.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
      if (!sawStartup && stdout.includes(STARTUP_LOG)) {
        sawStartup = true;
        child.kill('SIGTERM');
        // Bounded fallback: escalate to SIGKILL if SIGTERM does not settle.
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (killErr) {
            // Child already exited; nothing to reap.
          }
        }, SIGKILL_FALLBACK_MS);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.once('error', (err) => finish(err));
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      // Assert EXACT startup-line equality by matching a whole parsed line, not
      // a loose substring: a prefixed/suffixed or otherwise altered line must
      // fail. Diagnostics include stderr, exit code, and signal (C2-06).
      const lines = stdout.split(/\r?\n/);
      if (!lines.includes(STARTUP_LOG)) {
        finish(
          new Error(
            `expected exact startup line ${JSON.stringify(STARTUP_LOG)}; ` +
              `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} ` +
              `code=${code} signal=${signal}`
          )
        );
        return;
      }
      // Prove the fixed port 3000 was released once the child was reaped by
      // binding and immediately closing a probe on it. This confirms signal
      // termination + reaping released the port; it is NOT an assertion about
      // application-level graceful shutdown (server.js has none).
      const probe = http.createServer();
      probe.once('error', (probeErr) =>
        finish(new Error(`port 3000 was not released after the child exited: ${probeErr.code}`))
      );
      probe.listen(3000, '127.0.0.1', () => {
        probe.close(() => finish());
      });
    });
  }, 15000);
});

// Close the in-process coverage gap for server.js's direct-execution branch
// (the require.main guard and startup callback) using REAL execution from a
// dedicated child process. No-op unless Jest is collecting coverage, so a plain
// `npm test` neither spawns a child nor binds port 3000 here. Runs after all
// tests (and after the black-box child above has been reaped) and adds no
// additional test case, so the suite keeps exactly four tests (C2-07).
afterAll(async () => {
  await collectDirectRunCoverage();
});
