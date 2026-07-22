'use strict';

const request = require('supertest');
const server = require('../server');

const EXPECTED_BODY = 'Hello, World!\n';

// The response header NAME set the current server produces for a body-bearing
// request: the handler sets only Content-Type; Node 22 adds Date, Connection,
// and Content-Length automatically. Asserting this exact normalized set makes
// the suite fail if any arbitrary or sensitive header (e.g. Set-Cookie,
// X-Powered-By) is ever introduced, satisfying the "no anomalous headers beyond
// Node defaults" contract. The dynamic Date *value* is deliberately not
// asserted — only the presence of the `date` header name.
const DEFAULT_HEADER_NAMES = ['connection', 'content-length', 'content-type', 'date'];

// Concurrency lifecycle tuning. Bounded request timeouts guarantee every request
// settles even if a future handler regression never ends a response, so
// Promise.all can never hang the suite. The Jest per-test timeout is kept safely
// above the request deadline so a request-level timeout surfaces the useful root
// error first (instead of Jest's generic timeout).
const CONCURRENT_REQUESTS = 20;
const REQUEST_RESPONSE_TIMEOUT_MS = 5000;
const REQUEST_DEADLINE_TIMEOUT_MS = 8000;
const CONCURRENCY_TEST_TIMEOUT_MS = 15000;

// Promise wrapper around server.listen that is failure-safe: it resolves on the
// 'listening' event and rejects on 'error' (e.g. an asynchronous bind failure
// such as EADDRINUSE, which never invokes the listen callback). One-shot
// handlers remove each other on settle so no listener outlives the call.
function listenOnce(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.removeListener('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port);
  });
}

// Promise wrapper around server.close that rejects if the close callback reports
// an error, and resolves immediately when the server is not listening (which
// avoids the ERR_SERVER_NOT_RUNNING thrown by an unconditional close on a
// supertest-managed, non-listening server).
function closeOnce(srv) {
  return new Promise((resolve, reject) => {
    if (!srv.listening) {
      resolve();
      return;
    }
    srv.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('server.js HTTP response contract (F-002 handler)', () => {
  describe('happy path', () => {
    test("GET / returns 200 text/plain 'Hello, World!'", async () => {
      const res = await request(server).get('/');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe(EXPECTED_BODY);
    });
  });

  describe('response headers (no anomalous headers beyond Node defaults)', () => {
    test('GET / returns exactly the Node default header set plus Content-Type', async () => {
      const res = await request(server).get('/');
      expect(res.statusCode).toBe(200);
      // Objective assertion over the normalized (lowercased) header names:
      // exactly the Node 22 defaults plus the handler's Content-Type, and
      // nothing anomalous. Fails if any extra/sensitive header is added.
      expect(Object.keys(res.headers).sort()).toEqual(DEFAULT_HEADER_NAMES);
      // Retain the media-type assertion; the dynamic Date value is not asserted.
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });
  });

  describe('edge - routing (route-agnostic)', () => {
    const paths = ['/', '/hello', '/nested/deep/path', '/?q=1&x=2'];
    test.each(paths)('path %s returns identical 200 body', async (p) => {
      const res = await request(server).get(p);
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe(EXPECTED_BODY);
    });
  });

  describe('edge - methods (method-agnostic)', () => {
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options'];
    test.each(methods)('%s / returns 200 with body', async (m) => {
      const res = await request(server)[m]('/');
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe(EXPECTED_BODY);
    });

    test('HEAD / returns 200 with an empty body', async () => {
      const res = await request(server).head('/');
      expect(res.statusCode).toBe(200);
      expect(res.text).toBeFalsy();
    });
  });

  describe('edge - payloads (request body ignored)', () => {
    test('empty POST body returns 200', async () => {
      const res = await request(server).post('/').send('');
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe(EXPECTED_BODY);
    });

    test('1 MB POST body returns 200', async () => {
      const oneMB = 'x'.repeat(1024 * 1024);
      const res = await request(server).post('/').set('Content-Type', 'text/plain').send(oneMB);
      expect(res.statusCode).toBe(200);
      expect(res.text).toBe(EXPECTED_BODY);
    });
  });

  describe('edge - headers', () => {
    test('unusual request headers still yield 200 text/plain', async () => {
      const res = await request(server)
        .get('/')
        .set('X-Weird-Header', 'anything')
        .set('Accept', 'application/json');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe(EXPECTED_BODY);
      // Unusual REQUEST headers must not induce any anomalous RESPONSE header:
      // the normalized response-header name set stays the Node defaults + Content-Type.
      expect(Object.keys(res.headers).sort()).toEqual(DEFAULT_HEADER_NAMES);
    });
  });

  describe('edge - concurrency', () => {
    test('20 parallel requests each return identical 200 body', async () => {
      // Bind once so all concurrent requests share a single ephemeral port
      // (supertest re-binds a non-listening server per call, which races under
      // parallelism). listenOnce rejects on an async bind error instead of hanging.
      await listenOnce(server, 0);
      let primaryError;
      try {
        const responses = await Promise.all(
          Array.from({ length: CONCURRENT_REQUESTS }, () =>
            request(server)
              .get('/')
              .timeout({ response: REQUEST_RESPONSE_TIMEOUT_MS, deadline: REQUEST_DEADLINE_TIMEOUT_MS })
          )
        );
        responses.forEach((res) => {
          expect(res.statusCode).toBe(200);
          expect(res.text).toBe(EXPECTED_BODY);
        });
      } catch (err) {
        // Preserve the primary assertion/request error as the failure cause.
        primaryError = err;
      } finally {
        // Always attempt cleanup; only surface a cleanup error when there is no
        // primary error to preserve, so the useful root cause is not masked.
        try {
          await closeOnce(server);
        } catch (closeErr) {
          if (!primaryError) primaryError = closeErr;
        }
        if (primaryError) throw primaryError;
      }
    }, CONCURRENCY_TEST_TIMEOUT_MS);
  });
});

afterAll(async () => {
  // Error-aware, guarded teardown: awaits close and rejects on a close error,
  // while resolving safely if the server is already non-listening.
  await closeOnce(server);
});
