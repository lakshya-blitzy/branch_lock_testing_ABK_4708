'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const request = require('supertest');
const server = require('../server');

const EXPECTED_BODY = 'Hello, World!\n';
const STARTUP_LOG = 'Server running at http://127.0.0.1:3000/';

// Ensure the shared server instance is released after every test.
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

  test('binding an already-occupied port emits an EADDRINUSE error', (done) => {
    server.listen(0, '127.0.0.1', () => {
      const occupiedPort = server.address().port;
      const intruder = http.createServer();
      intruder.once('error', (err) => {
        expect(err.code).toBe('EADDRINUSE');
        intruder.close(() => done());
      });
      intruder.listen(occupiedPort, '127.0.0.1');
    });
  });
});

describe('server.js error handling (Node default behavior)', () => {
  test('malformed request yields 400; a subsequent valid request still returns 200', (done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: not-a-number\r\n\r\n');
      });
      let raw = '';
      socket.on('data', (chunk) => {
        raw += chunk.toString();
      });
      socket.on('close', () => {
        expect(raw).toMatch(/^HTTP\/1\.1 400/);
        request(server)
          .get('/')
          .then((res) => {
            expect(res.statusCode).toBe(200);
            expect(res.text).toBe(EXPECTED_BODY);
            done();
          })
          .catch(done);
      });
      socket.on('error', done);
    });
  });
});

describe('server.js startup log (F-003, black-box)', () => {
  test('running "node server.js" prints the startup line and terminates cleanly', (done) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
    });
    let stdout = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      done(err);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(STARTUP_LOG)) {
        child.kill('SIGTERM');
      }
    });
    child.on('error', finish);
    child.on('exit', () => {
      try {
        expect(stdout).toContain(STARTUP_LOG);
        finish();
      } catch (err) {
        finish(err);
      }
    });
  }, 15000);
});
