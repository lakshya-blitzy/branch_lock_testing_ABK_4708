'use strict';

const request = require('supertest');
const server = require('../server');

const EXPECTED_BODY = 'Hello, World!\n';

describe('server.js HTTP response contract (F-002 handler)', () => {
  describe('happy path', () => {
    test("GET / returns 200 text/plain 'Hello, World!'", async () => {
      const res = await request(server).get('/');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toBe(EXPECTED_BODY);
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
    });
  });

  describe('edge - concurrency', () => {
    test('20 parallel requests each return identical 200 body', async () => {
      // Bind once so all concurrent requests share a single ephemeral port
      // (supertest re-binds a non-listening server per call, which races under parallelism).
      await new Promise((resolve) => server.listen(0, resolve));
      try {
        const responses = await Promise.all(
          Array.from({ length: 20 }, () => request(server).get('/'))
        );
        responses.forEach((res) => {
          expect(res.statusCode).toBe(200);
          expect(res.text).toBe(EXPECTED_BODY);
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

afterAll((done) => {
  if (server.listening) server.close(done);
  else done();
});
