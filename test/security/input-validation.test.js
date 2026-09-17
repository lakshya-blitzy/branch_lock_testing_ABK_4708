'use strict';

/**
 * Input-validation and method-allow-list regression suite.
 *
 * FINDINGS UNDER TEST
 * -------------------
 * V-02  Absent input validation; unbounded request body (CWE-20, CWE-770).
 *       The pre-remediation handler - `server.js` lines 6-10 of the original
 *       14-line listener - never read `req` at all. It inspected neither
 *       `req.method`, nor `req.url`, nor `req.headers`, nor the body; it wrote
 *       `200` and a fixed string unconditionally, so every request was "valid"
 *       by construction. Probing the original proved it: `DELETE
 *       /../../etc/passwd` answered `200`, and a `PUT /` carrying a
 *       100,000-byte body answered `200` with the payload accepted unbounded.
 *
 * V-07  Cross-Site Tracing (CWE-16). `TRACE /` answered `200` for the same
 *       reason - no verb was ever filtered.
 *
 * This suite's job is therefore to prove that REJECTION now happens, on four
 * independent axes: method, path, size and shape.
 *
 * THESE STATUS CHANGES ARE THE FIX, NOT A REGRESSION
 * --------------------------------------------------
 * A reviewer reading `405` where the service once returned `200` is reading
 * the remediation. Each change below is a deliberate, security-justified
 * behaviour change:
 *
 *   non-allow-listed methods      200 -> 405 + `Allow`   (V-02, V-07)
 *   unknown paths                 200 -> 404             (V-02)
 *   malformed / bounded-out input  200 -> 400            (V-02)
 *   oversized payloads            200 -> 405 or 413      (V-02)
 *
 * What did NOT change is asserted by `behavior-preservation.test.js`: `GET /`
 * still returns `200` with a body of exactly 14 bytes.
 *
 * WHY EVERY METHOD PROBE TARGETS THE ROOT PATH SPECIFICALLY
 * ---------------------------------------------------------
 * This is the single most consequential implementation detail in the whole
 * remediation, and the method matrix below is its only mechanical guard.
 *
 * The method allow-list MUST be top-level `app.use` middleware. An earlier
 * prototype expressed it as a catch-all route, `app.all('/*splat', ...)`, and
 * `TRACE /` then answered `404` instead of `405`, because an Express 5
 * wildcard route does not match the root path. Only top-level middleware sees
 * every request regardless of path. A matrix probed against `/nope` would
 * have passed while Cross-Site Tracing stayed wide open on `/`. Do not
 * relocate these probes to a non-root path for convenience.
 *
 * OBSERVED CONTRACT, MEASURED RATHER THAN ASSUMED
 * -----------------------------------------------
 * Every expectation in this file was measured against this pipeline on the
 * runtime the build pins (`pom.xml` `<node.version>24.16.0`):
 *
 *   GET     / -> 200   text/plain; charset=utf-8
 *   HEAD    / -> 200   no body, by protocol
 *   POST    / -> 405   Allow: GET, HEAD   application/problem+json
 *   PUT     / -> 405   Allow: GET, HEAD   (even with a 100,000-byte body)
 *   DELETE  / -> 405   Allow: GET, HEAD
 *   PATCH   / -> 405   Allow: GET, HEAD
 *   OPTIONS / -> 204   cors short-circuits preflight before the method guard
 *   TRACE   / -> 405   Allow: GET, HEAD   no echo of the request
 *   TRACK   / -> 400   refused by Node's own HTTP parser, before Express
 *
 * The `OPTIONS` and `TRACK` rows are the two that a reviewer is most likely
 * to expect differently; each is explained at its own test.
 *
 * SCOPE - WHAT THIS FILE DELIBERATELY DOES NOT ASSERT
 * ---------------------------------------------------
 * Security-header values live in `headers.test.js`; `Access-Control-*`
 * headers live in `cors.test.js`; `429` and the `RateLimit` headers live in
 * `rate-limit.test.js`; transport in `tls.test.js`; the 14-byte body in
 * `behavior-preservation.test.js`. Nothing here asserts `Content-Type ===
 * 'text/plain'` (Express normalises it to `text/plain; charset=utf-8`) or the
 * absence of `ETag` (Express adds a weak one) - both are benign deltas of the
 * framework introduction, not defects.
 *
 * GOVERNING STANDARDS
 * -------------------
 *   OWASP ASVS v4 V5        every input surface - path, query, headers, body -
 *                           is validated; this file is the proof for the
 *                           surfaces reachable over HTTP.
 *   OWASP Top 10 2021 A01   the method allow-list (broken access control).
 *   OWASP Top 10 2021 A03   schema validation (injection).
 *   OWASP API Top 10 API4   the request-body ceiling (unrestricted resource
 *                           consumption).
 *   RFC 9457                every rejection is `application/problem+json`
 *                           carrying `type`, `title` and `status`.
 *   Least privilege         the allow-list admits only the two verbs the
 *                           service implements, which is why `Allow` is
 *                           asserted exactly as `GET, HEAD` rather than
 *                           loosely.
 *
 * HARNESS
 * -------
 * The runtime's own `node:test` with `node:assert/strict`, driving the
 * exported Express application in-process through `supertest` - no fixed port
 * is ever bound. `TRACK` cannot be expressed by `supertest`/`superagent` (the
 * verb is absent from the `methods` package), and a literal request target
 * must survive client-side normalisation for the traversal probe, so this
 * file carries ONE inline raw-`http` helper for those cases. It is inline
 * deliberately: `test/security/` holds exactly six test files and no shared
 * helper module.
 */

// Run with the QUOTED GLOB:  node --test "test/**/*.test.js"
// The directory form, `node --test test/`, fails with MODULE_NOT_FOUND on this
// runtime, which would make a fully working security suite appear broken.

/* -------------------------------------------------------------------------
 * Configuration, set BEFORE the application is required.
 *
 * `config/security.js` reads `process.env` at its own require time and
 * freezes what it resolved, and `server.js` requires it transitively, so an
 * assignment made after the require below would have no effect whatsoever.
 * Under `node --test` each test file runs in its own child process, so these
 * assignments cannot leak into a sibling suite.
 * ---------------------------------------------------------------------- */

/**
 * Raise the rate-limit budget out of the way. This file needs it more than
 * any other in the folder: the method matrix alone issues nine requests and
 * the whole suite well over two dozen, against a default budget of 100 per 15
 * minutes shared across the entire file. Without this, a late `429` could
 * masquerade as a validation result and the failure would be baffling.
 * `rate-limit.test.js` is the one suite that deliberately sets a small
 * budget; it must stay the only one.
 */
process.env.RATE_LIMIT_MAX = '1000000';

/**
 * Exercise the REAL default method allow-list (`GET, HEAD`) from
 * `config/security.js` rather than whatever the host environment happens to
 * carry. The variable is removed rather than assigned: assigning it would
 * test this file's literal instead of the shipped default, and inheriting a
 * host value could admit a verb the matrix below expects to be refused.
 */
delete process.env.ALLOWED_METHODS;

/**
 * Likewise for the body ceiling: this suite asserts the SHIPPED default
 * (`1kb`), so an inherited `JSON_BODY_LIMIT` must not decide what the
 * configuration assertions below measure.
 */
delete process.env.JSON_BODY_LIMIT;

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const request = require('supertest');

// The hardened application, with no socket bound: `server.js` guards
// `listen()` behind `require.main === module` precisely so this import is
// side-effect free.
const { app } = require('../../server.js');

// The single source of truth for the allow-list and the body ceiling. Read
// here so the assertions below cannot drift from the shipped configuration.
const cfg = require('../../config/security.js');

// Imported for ONE purpose: the path-parameter surface is unreachable over
// HTTP (the route table holds exactly one literal route, so no request can
// produce a path parameter), and ASVS V5 still requires it to be validated.
// Its schema is therefore asserted directly, as a unit, in the final section.
const validation = require('../../src/middleware/validation.js');

// `src/app.js`, `src/middleware/security.js` and `src/middleware/errors.js`
// are deliberately NOT imported. They are the behaviour under test, and they
// are exercised end to end through the application above: asserting on a
// middleware's exports instead of on the wire would prove the stage exists
// without proving it is MOUNTED, in the mandatory order, on the path a
// request actually takes - which is the property that closes these findings.

/* -------------------------------------------------------------------------
 * Constants. Every status and media type the pipeline emits is named, so no
 * assertion below carries an unexplained literal.
 * ---------------------------------------------------------------------- */

/** Loopback address for the raw helper's ephemeral listener. */
const LOOPBACK = '127.0.0.1';

const OK_STATUS = 200;
const NO_CONTENT_STATUS = 204;
const BAD_REQUEST_STATUS = 400;
const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;

/** RFC 9457 media type, asserted as a substring so Express's charset fits. */
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** RFC 9457's designated `type` when a problem has no documentation URI. */
const PROBLEM_TYPE = 'about:blank';

/**
 * The RFC 9457 registered members. The handler emits only the first three and
 * deliberately no `detail` and no `instance`; the assertion is that NOTHING
 * outside this set appears, which is what keeps an internal member - a
 * validation summary, an error message, a stack - out of a response body.
 */
const PROBLEM_MEMBERS = Object.freeze(['type', 'title', 'status', 'detail', 'instance']);

/**
 * The verbs the allow-list admits, and the `Allow` field value derived from
 * the SAME configuration array the middleware joins. Deriving it rather than
 * repeating the literal is what makes `Allow: GET, HEAD` an assertion about
 * the configured policy instead of an assertion about this file.
 */
const ALLOWED_METHODS = Object.freeze(cfg.methods.allowed.map((method) => method.toUpperCase()));
const ALLOW_HEADER_VALUE = ALLOWED_METHODS.join(', ');

/**
 * Verbs that must be refused with `405` and an `Allow` header. `OPTIONS` and
 * `TRACK` are absent on purpose - each is refused earlier in the stack, by a
 * different mechanism, and each has its own test below.
 */
const REJECTED_METHODS = Object.freeze(['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE']);

/** The exact payload size the original listener accepted unbounded. */
const OVERSIZED_BODY_BYTES = 100000;

/**
 * Probe magnitudes for the bounded-input surfaces, each comfortably above the
 * bound documented in `src/middleware/validation.js` so the rejection is
 * deterministic rather than borderline:
 *
 *   MAX_QUERY_PARAMETERS   32   -> 64 parameters
 *   MAX_QUERY_KEY_LENGTH   64   -> a 160-character key
 *   MAX_QUERY_VALUE_LENGTH 512  -> a 1024-character value
 *   MAX_CONTENT_TYPE_LENGTH 512 -> a 1024-character `Content-Type`
 *
 * The bounds themselves are module-private constants of that middleware, so
 * they are cited here rather than imported; exporting them purely for a test
 * would widen that module's public surface for no security benefit.
 */
const QUERY_PARAMETER_PROBE_COUNT = 64;
const QUERY_KEY_PROBE_LENGTH = 160;
const QUERY_VALUE_PROBE_LENGTH = 1024;
const CONTENT_TYPE_PROBE_LENGTH = 1024;

/**
 * Header the Cross-Site Tracing probes carry, with a value no part of this
 * service could produce. A `TRACE` implementation that echoed the request -
 * the XST primitive - would reproduce both in the response body.
 */
const ECHO_HEADER = 'X-Cross-Site-Tracing-Probe';
const ECHO_MARKER = 'xst-echo-marker-9f2c41d7';

/**
 * Substrings that must never appear in a rejection body (CWE-209-class
 * information disclosure). `    at ` catches a V8 stack frame, `node_modules`
 * and an absolute path catch filesystem disclosure, and a dependency name
 * catches the "helpful" error body that names the library that failed.
 */
const DISCLOSURE_MARKERS = Object.freeze([
  'stack',
  '    at ',
  'node_modules',
  'Error:',
  'express',
  'helmet',
  'zod',
  'body-parser',
  'ZodError',
  '/etc/',
  '/home/',
  '/usr/',
  '/tmp/',
  __dirname,
  process.cwd(),
]);

/**
 * A dotted version triple. A rejection body naming a dependency version hands
 * an attacker the advisory lookup for free, so no `4.17.21`-shaped string may
 * appear in one.
 */
const VERSION_PATTERN = /\d+\.\d+\.\d+/;

/** Filesystem content a traversal attempt must never bring back. */
const FILESYSTEM_MARKERS = Object.freeze(['root:', 'daemon:', '/bin/bash', '/bin/sh']);

/* -------------------------------------------------------------------------
 * The one inline helper this file legitimately needs.
 * ---------------------------------------------------------------------- */

/**
 * Issue a single raw HTTP request against the application and resolve with
 * the status, headers and body as received on the wire.
 *
 * Two probes in this file cannot be expressed through `supertest`:
 *
 *   - `TRACK` is not a member of the `methods` package, so `superagent`
 *     exposes no verb for it and cannot be coerced into sending one.
 *   - The traversal probe's request target must reach the server LITERALLY,
 *     with its `../` segments intact, rather than being normalised by a URL
 *     parser on the client side before it is ever sent.
 *
 * The listener binds an EPHEMERAL port (`0`) on loopback - exactly the
 * mechanism `supertest` uses internally - so it introduces no fixed-port
 * collision risk on a host running many suites at once, and it keeps the
 * in-process harness principle intact.
 *
 * `agent: false` gives the request a one-off agent with keep-alive disabled,
 * so the socket is not held open after the response and `close()` completes
 * promptly; `closeAllConnections()` is then called defensively. Every exit
 * path - response end, response error, request error, listener error -
 * settles exactly once and closes the listener first, so the test process
 * ends with no dangling handle and needs no `process.exit()`.
 *
 * @param {string} method HTTP method, sent verbatim and uppercase.
 * @param {string} path Literal request target, sent without normalisation.
 * @param {{headers?: Object<string, string>, body?: string}} [options]
 *   Request headers and an optional request body.
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
const rawRequest = (method, path, options = {}) =>
  new Promise((resolve, reject) => {
    const listener = http.createServer(app);
    let settled = false;

    /**
     * Close the listener, then settle. Guarded so a second event - an error
     * arriving after the response, say - cannot double-settle or double-close.
     *
     * @param {Error|null} error failure to reject with, or `null` to resolve
     * @param {Object} [value] resolution value
     * @returns {void}
     */
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;

      const settle = () => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };

      try {
        if (typeof listener.closeAllConnections === 'function') {
          listener.closeAllConnections();
        }
        // The close callback receives ERR_SERVER_NOT_RUNNING when the socket
        // never bound; it is ignored deliberately, because the outcome of the
        // request is what this helper reports.
        listener.close(() => settle());
      } catch {
        settle();
      }
    };

    listener.on('error', (error) => finish(error));

    listener.listen(0, LOOPBACK, () => {
      const address = listener.address();
      const clientRequest = http.request(
        {
          host: LOOPBACK,
          port: address.port,
          method,
          path,
          headers: options.headers || {},
          agent: false,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', (error) => finish(error));
          response.on('end', () =>
            finish(null, {
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          );
        }
      );

      clientRequest.on('error', (error) => finish(error));

      if (options.body !== undefined) {
        clientRequest.write(options.body);
      }
      clientRequest.end();
    });
  });

/* -------------------------------------------------------------------------
 * Shared assertions.
 * ---------------------------------------------------------------------- */

/**
 * Assert that a body discloses nothing internal.
 *
 * Applied to every rejection this suite provokes, because the error path is
 * exactly what an attacker probes: a `404` that names a filesystem path or a
 * `400` that echoes a `zod` issue would hand over information the success
 * path never reveals (CWE-209).
 *
 * @param {string} body serialised response body
 * @param {string} label context for the failure message
 * @returns {void}
 */
const assertNoDisclosure = (body, label) => {
  for (const marker of DISCLOSURE_MARKERS) {
    assert.ok(
      !body.includes(marker),
      `${label}: rejection body must not disclose "${marker}"; received ${JSON.stringify(body)}`
    );
  }

  assert.ok(
    !VERSION_PATTERN.test(body),
    `${label}: rejection body must not disclose a dependency version; received ${JSON.stringify(body)}`
  );
};

/**
 * Assert that a response is a well-formed RFC 9457 problem document for the
 * expected status, and that it leaks nothing.
 *
 * The media type is matched as a substring because Express appends a charset,
 * so the header observed on the wire is `application/problem+json;
 * charset=utf-8`. The member set is asserted to be a SUBSET of the registered
 * RFC 9457 members, which is the assertion that actually prevents an internal
 * member - a validation summary, an error message, a stack - from reaching a
 * client, and it stays correct if a future change adds a safe `detail`.
 *
 * @param {{status: number, headers: Object, body: string}} response raw response
 * @param {number} expectedStatus status the problem document must report
 * @param {string} label context for the failure message
 * @returns {Object} the parsed problem document
 */
const assertProblemDocument = (response, expectedStatus, label) => {
  assert.equal(response.status, expectedStatus, `${label}: unexpected HTTP status`);

  const contentType = response.headers['content-type'];
  assert.ok(
    typeof contentType === 'string' && contentType.includes(PROBLEM_MEDIA_TYPE),
    `${label}: Content-Type must contain ${PROBLEM_MEDIA_TYPE}; received ${JSON.stringify(contentType)}`
  );

  let document;
  try {
    document = JSON.parse(response.body);
  } catch (error) {
    assert.fail(
      `${label}: body must be a JSON problem document; received ${JSON.stringify(response.body)} (${error.message})`
    );
  }

  assert.ok(
    document !== null && typeof document === 'object' && !Array.isArray(document),
    `${label}: problem document must be a JSON object`
  );

  for (const member of Object.keys(document)) {
    assert.ok(
      PROBLEM_MEMBERS.includes(member),
      `${label}: problem document carries the unregistered member "${member}", which risks disclosing internals`
    );
  }

  assert.equal(document.type, PROBLEM_TYPE, `${label}: problem "type" must be ${PROBLEM_TYPE}`);
  assert.equal(typeof document.title, 'string', `${label}: problem "title" must be a string`);
  assert.ok(document.title.length > 0, `${label}: problem "title" must not be empty`);
  assert.equal(
    document.status,
    expectedStatus,
    `${label}: problem "status" must equal the HTTP status`
  );

  assertNoDisclosure(response.body, label);

  return document;
};

/**
 * The same problem-document assertion for a `supertest` response, whose shape
 * differs from the raw helper's. One conversion keeps a single assertion path
 * rather than two that could drift apart.
 *
 * @param {Object} response `supertest` response
 * @param {number} expectedStatus status the problem document must report
 * @param {string} label context for the failure message
 * @returns {Object} the parsed problem document
 */
const assertProblemResponse = (response, expectedStatus, label) =>
  assertProblemDocument(
    {
      status: response.status,
      headers: response.headers,
      body: typeof response.text === 'string' ? response.text : '',
    },
    expectedStatus,
    label
  );

/**
 * Assert the `Allow` header of a `405`, against the value derived from the
 * configured allow-list rather than a repeated literal.
 *
 * RFC 9110 makes `Allow` mandatory on a `405`: without it a client cannot
 * discover which verbs the resource supports, and the rejection is
 * unactionable.
 *
 * @param {Object} headers response headers, lower-cased keys
 * @param {string} label context for the failure message
 * @returns {void}
 */
const assertAllowHeader = (headers, label) => {
  assert.equal(
    headers.allow,
    ALLOW_HEADER_VALUE,
    `${label}: a 405 must carry Allow: ${ALLOW_HEADER_VALUE}`
  );
};

/**
 * Build a query string of `count` distinct parameters.
 *
 * @param {number} count number of parameters
 * @returns {string} query string with no leading `?`
 */
const buildQuery = (count) => {
  const parameters = [];
  for (let index = 0; index < count; index += 1) {
    parameters.push(`k${index}=1`);
  }
  return parameters.join('&');
};

/** Byte multipliers of the size grammar the body parsers accept. */
const BYTE_UNITS = Object.freeze({ b: 1, kb: 1024, mb: 1048576, gb: 1073741824 });

/**
 * Resolve a body-limit string to a byte count, so the ceiling can be asserted
 * as a MAGNITUDE rather than as a string that merely looks bounded.
 *
 * @param {string} limit value of `cfg.body.jsonLimit`
 * @returns {number} byte count, or `NaN` when the value is not a byte size
 */
const limitToBytes = (limit) => {
  const match = /^([0-9]+(?:\.[0-9]+)?) *(b|kb|mb|gb)?$/i.exec(String(limit).trim());
  if (match === null) {
    return Number.NaN;
  }
  const unit = match[2] === undefined ? 'b' : match[2].toLowerCase();
  return Number(match[1]) * BYTE_UNITS[unit];
};

/* -------------------------------------------------------------------------
 * 1 - The method matrix, probed against the ROOT PATH.
 *
 * This is the regression test for the catch-all-route defect described in
 * this file's header: every probe here targets `/` because that is the one
 * path an Express 5 wildcard route fails to match, and therefore the one path
 * on which a mis-implemented guard leaks.
 * ---------------------------------------------------------------------- */

describe('V-02, V-07 - the HTTP method allow-list at the root path', () => {
  it('admits only the two verbs the service implements (least privilege)', () => {
    assert.deepEqual(
      ALLOWED_METHODS,
      ['GET', 'HEAD'],
      'the shipped allow-list must admit GET and HEAD and nothing else'
    );
    assert.equal(
      ALLOW_HEADER_VALUE,
      'GET, HEAD',
      'the Allow field value is the allow-list joined with a comma and a space (RFC 9110)'
    );
  });

  it('answers GET / and HEAD / with 200', async () => {
    const getResponse = await request(app).get('/');
    assert.equal(getResponse.status, OK_STATUS, 'GET / must still succeed');

    const headResponse = await request(app).head('/');
    assert.equal(headResponse.status, OK_STATUS, 'HEAD / must still succeed');

    // The exact 14-byte body is `behavior-preservation.test.js`'s assertion;
    // what matters here is that hardening did not turn a permitted verb into
    // a rejection.
  });

  it('refuses every non-allow-listed verb at / with 405 and an Allow header', async () => {
    for (const method of REJECTED_METHODS) {
      const label = `${method} /`;
      const response = await request(app)[method.toLowerCase()]('/');

      assertProblemResponse(response, METHOD_NOT_ALLOWED_STATUS, label);
      assertAllowHeader(response.headers, label);
    }
  });

  it('answers OPTIONS / with 204 - cors short-circuits before the method guard', async () => {
    // READ OFF THE IMPLEMENTATION, not assumed. `cors` is mounted ahead of
    // the method allow-list (Ordering Rule 2) so that preflight is answered
    // before any verb is filtered, and it short-circuits EVERY `OPTIONS`
    // request with its configured success status - including a request
    // carrying no `Origin` header at all, because the origin callback in
    // `src/middleware/security.js` always resolves with the allow-list array
    // rather than a falsy value.
    //
    // The alternative outcome, `405`, is what the plan's own verified matrix
    // records (AAP 0.5.1.1 and 0.8.2.2: `200 200 405 405 405 405 405 405`);
    // it arises only where the origin callback refuses an origin-less request
    // and the verb therefore falls through to the method guard. This pipeline
    // does not, so `204` is the correct expectation here.
    //
    // Either way the security position is identical: `OPTIONS` reaches no
    // handler and returns no resource content. Whether a DENIED origin's
    // preflight is distinguishable is a CORS question, and the control there
    // is the ABSENCE of `Access-Control-Allow-Origin` rather than the status
    // - asserted in `cors.test.js`, deliberately not here.
    const response = await request(app).options('/');

    assert.equal(
      response.status,
      NO_CONTENT_STATUS,
      'OPTIONS / must be answered by the cors preflight short-circuit'
    );
    assert.equal(
      typeof response.text === 'string' ? response.text : '',
      '',
      'a 204 preflight must carry no body'
    );
  });

  it('refuses an unknown verb at a non-root path too, without leaking the path', async () => {
    // The root path is what the matrix above guards; this confirms the guard
    // is genuinely path-independent, which is the property a catch-all route
    // would have satisfied here while failing on `/`.
    const label = 'POST /nope';
    const response = await request(app).post('/nope');

    assertProblemResponse(response, METHOD_NOT_ALLOWED_STATUS, label);
    assertAllowHeader(response.headers, label);
    assert.ok(
      !response.text.includes('nope'),
      `${label}: the rejection must not echo the request target`
    );
  });
});

/* -------------------------------------------------------------------------
 * 2 - Cross-Site Tracing (V-07, CWE-16).
 *
 * `TRACE` and `TRACK` are closed by simple ABSENCE from the allow-list -
 * `config/security.js` goes further and refuses to admit either verb through
 * configuration at all. That is one layer of a defence in depth that also
 * includes serving no HTML surface and `X-XSS-Protection: 0` (the legacy
 * auditor is disabled deliberately; a reviewer expecting `1; mode=block`
 * should not "fix" it - see `headers.test.js`).
 * ---------------------------------------------------------------------- */

describe('V-07 - Cross-Site Tracing is closed', () => {
  it('refuses TRACE / with 405 and echoes no request header back', async () => {
    const label = 'TRACE /';
    const response = await request(app).trace('/').set(ECHO_HEADER, ECHO_MARKER);

    assertProblemResponse(response, METHOD_NOT_ALLOWED_STATUS, label);
    assertAllowHeader(response.headers, label);

    const body = typeof response.text === 'string' ? response.text : '';
    assert.ok(!body.includes(ECHO_MARKER), `${label}: the body must not echo the probe value`);
    assert.ok(
      !body.toLowerCase().includes(ECHO_HEADER.toLowerCase()),
      `${label}: the body must not echo the probe header name`
    );
  });

  it('refuses TRACK / and echoes no request header back', async () => {
    // `TRACK` needs the raw helper: the verb is absent from the `methods`
    // package, so `supertest`/`superagent` cannot send it.
    //
    // MEASURED OUTCOME, and it is not the one a reader expects: on this
    // runtime `TRACK` never reaches Express. `TRACK` is not a registered HTTP
    // method and is absent from the parser's method table, so Node's own HTTP
    // parser refuses the request with a bare `400` and closes the connection
    // before any middleware runs - which is why this response carries neither
    // `Allow` nor the twelve security headers.
    //
    // Both refusal paths are asserted below rather than one being assumed,
    // because which one applies is a property of the runtime's parser, not of
    // this service: a runtime that admitted the verb would hand it to the
    // top-level method guard, and the guard would answer `405` with `Allow`
    // exactly as it does for `TRACE`. Neither branch permits the verb, and
    // `config/security.js` forbids admitting `TRACK` through
    // `ALLOWED_METHODS` under any configuration, so the Cross-Site Tracing
    // primitive is unreachable either way.
    const label = 'TRACK /';
    const response = await rawRequest('TRACK', '/', { headers: { [ECHO_HEADER]: ECHO_MARKER } });

    assert.ok(
      response.status >= BAD_REQUEST_STATUS && response.status < 500,
      `${label}: must be refused with a 4xx; received ${response.status}`
    );
    assert.ok(
      !response.body.includes(ECHO_MARKER),
      `${label}: the body must not echo the probe value`
    );
    assert.ok(
      !response.body.toLowerCase().includes(ECHO_HEADER.toLowerCase()),
      `${label}: the body must not echo the probe header name`
    );

    if (response.status === METHOD_NOT_ALLOWED_STATUS) {
      assertProblemDocument(response, METHOD_NOT_ALLOWED_STATUS, label);
      assertAllowHeader(response.headers, label);
      return;
    }

    assert.equal(
      response.status,
      BAD_REQUEST_STATUS,
      `${label}: an unregistered verb is refused by the HTTP parser with 400`
    );
    assert.equal(response.body, '', `${label}: the parser's refusal carries no body`);
  });
});

/* -------------------------------------------------------------------------
 * 3 - Unknown paths (V-02).
 *
 * The original listener answered `200` for every path, because it never read
 * `req.url`. There is now an explicit route table of exactly one literal
 * route, and everything else reaches the terminal 404 handler.
 * ---------------------------------------------------------------------- */

describe('V-02 - unknown paths are refused', () => {
  it('answers GET /nope with a 404 problem document', async () => {
    const label = 'GET /nope';
    const response = await request(app).get('/nope');

    assertProblemResponse(response, NOT_FOUND_STATUS, label);
  });

  it('does not disclose a filesystem path or enumerate the route table', async () => {
    const label = 'GET /not-a-route/at-all';
    const response = await request(app).get('/not-a-route/at-all');

    const document = assertProblemResponse(response, NOT_FOUND_STATUS, label);

    // `assertProblemDocument` already refuses any member outside the RFC 9457
    // registered set and any disclosure marker; these two assertions pin the
    // specific leaks a 404 handler most often commits - echoing the target
    // back, or listing what WOULD have matched.
    assert.ok(
      !response.text.includes('not-a-route'),
      `${label}: the rejection must not echo the request target`
    );
    assert.ok(
      !response.text.includes('/'),
      `${label}: the rejection must not name a path or a route`
    );
    assert.equal(
      Object.keys(document).length,
      3,
      `${label}: the document is exactly type, title and status - no detail, no instance`
    );
  });
});

/* -------------------------------------------------------------------------
 * 4 - Traversal-shaped request targets (V-02).
 *
 * The original answered `200` to `DELETE /../../etc/passwd`. Nothing in this
 * service reads the filesystem in response to a request, so the finding was
 * never "traversal reads a file" - it was that an arbitrary target reached a
 * handler at all. These probes prove the target is now filtered, and that
 * nothing resembling file content ever comes back.
 * ---------------------------------------------------------------------- */

describe('V-02 - traversal-shaped request targets are refused', () => {
  it('refuses DELETE /../../etc/passwd with 405 - the method guard runs before routing', async () => {
    // The path is irrelevant to this rejection, and that is the point: the
    // method allow-list is top-level middleware, so it filters the verb
    // before the router ever considers the target.
    const label = 'DELETE /../../etc/passwd';
    const response = await request(app).delete('/../../etc/passwd');

    assertProblemResponse(response, METHOD_NOT_ALLOWED_STATUS, label);
    assertAllowHeader(response.headers, label);
    assert.ok(response.status < 200 || response.status >= 300, `${label}: must not succeed`);

    for (const marker of FILESYSTEM_MARKERS) {
      assert.ok(
        !response.text.includes(marker),
        `${label}: the response must not contain filesystem content ("${marker}")`
      );
    }
  });

  it('refuses GET /../../etc/passwd with 404 from the route table', async () => {
    // The raw helper is used so the request target reaches the server
    // LITERALLY, with its `../` segments intact: a client-side URL parser
    // would otherwise normalise the probe into `GET /`, which succeeds, and
    // the test would silently assert nothing.
    //
    // `GET` is allow-listed, so the verb guard passes it through; the target
    // then matches no route and the terminal 404 handler answers. That is the
    // exact expectation, pinned rather than tolerated - a `400` would also be
    // defensible if the validation layer rejected the path shape first, but
    // this pipeline validates path PARAMETERS (of which there are none) and
    // not the raw target, so `404` is what it returns.
    const label = 'GET /../../etc/passwd';
    const response = await rawRequest('GET', '/../../etc/passwd');

    assertProblemDocument(response, NOT_FOUND_STATUS, label);
    assert.ok(response.status < 200 || response.status >= 300, `${label}: must not succeed`);

    for (const marker of FILESYSTEM_MARKERS) {
      assert.ok(
        !response.body.includes(marker),
        `${label}: the response must not contain filesystem content ("${marker}")`
      );
    }
  });

  it('refuses a percent-encoded traversal target the same way', async () => {
    // `%2e%2e` is the encoded form of `..`; a decode-then-route implementation
    // would treat it differently from the literal form, so both are probed.
    const label = 'GET /%2e%2e/%2e%2e/etc/passwd';
    const response = await rawRequest('GET', '/%2e%2e/%2e%2e/etc/passwd');

    assertProblemDocument(response, NOT_FOUND_STATUS, label);

    for (const marker of FILESYSTEM_MARKERS) {
      assert.ok(
        !response.body.includes(marker),
        `${label}: the response must not contain filesystem content ("${marker}")`
      );
    }
  });
});

/* -------------------------------------------------------------------------
 * 5 - The unbounded request body (V-02, CWE-770).
 * ---------------------------------------------------------------------- */

describe('V-02 - an oversized request body is refused', () => {
  it('refuses a 100,000-byte PUT / with 405, before any parser reads a byte', async () => {
    // DO NOT ASSERT 413 HERE. This is the second-most-likely mis-assertion in
    // this folder, after expecting a non-204 preflight for a denied origin.
    //
    // With the allow-list at `GET, HEAD`, the top-level method guard sits
    // AHEAD of the body parsers, so `PUT` is refused with `405` before a
    // parser is ever reached: the oversized payload is never buffered, never
    // parsed and never measured. A `413` expectation would fail against the
    // correct implementation - and, worse, "fixing" the implementation to
    // produce `413` would mean admitting `PUT` to the allow-list, which is
    // the vulnerability.
    //
    // 100,000 bytes is the exact payload the pre-remediation listener
    // accepted with a `200`.
    const label = `PUT / with ${OVERSIZED_BODY_BYTES} bytes`;
    const payload = 'a'.repeat(OVERSIZED_BODY_BYTES);

    assert.equal(
      Buffer.byteLength(payload),
      OVERSIZED_BODY_BYTES,
      'the probe must send exactly the payload size the original accepted'
    );

    const response = await request(app)
      .put('/')
      .set('Content-Type', 'application/json')
      .send(payload);

    assertProblemResponse(response, METHOD_NOT_ALLOWED_STATUS, label);
    assertAllowHeader(response.headers, label);
  });

  it('caps the request body by configuration, not by accident', async () => {
    // The `405` above is the verified behaviour, but it proves the METHOD
    // axis rather than the SIZE axis. The ceiling itself is therefore
    // evidenced here, deterministically and without depending on a verb the
    // allow-list refuses: `config/security.js` resolves one limit, the
    // security middleware passes it to every body parser, and a parser treats
    // a limit it cannot understand as NO LIMIT AT ALL - which is precisely
    // how an unbounded body would silently return.
    const limit = cfg.body.jsonLimit;

    assert.equal(typeof limit, 'string', 'the body ceiling must be a byte-size string');
    assert.notEqual(limit.trim(), '', 'the body ceiling must not be empty');

    const unbounded = ['0', '0b', '0kb', '-1', 'infinity', 'none', 'unlimited'];
    assert.ok(
      !unbounded.includes(limit.trim().toLowerCase()),
      `the body ceiling must not be an unbounded sentinel; received ${JSON.stringify(limit)}`
    );

    const bytes = limitToBytes(limit);
    assert.ok(
      Number.isFinite(bytes),
      `the body ceiling must parse as a byte size; received ${JSON.stringify(limit)}`
    );
    assert.ok(bytes > 0, `the body ceiling must be positive; received ${JSON.stringify(limit)}`);
    assert.ok(
      bytes < OVERSIZED_BODY_BYTES,
      `the body ceiling must sit well below the ${OVERSIZED_BODY_BYTES}-byte payload the original accepted; received ${JSON.stringify(limit)}`
    );
  });
});

/* -------------------------------------------------------------------------
 * 6 - Schema validation (V-02, OWASP ASVS v4 V5, OWASP A03).
 *
 * The four input surfaces are validated with different POLICIES, and the
 * difference is deliberate rather than accidental, so each is probed for the
 * behaviour it actually implements:
 *
 *   query    BOUNDED, not whitelisted. Unknown keys pass - `GET /?x=1`
 *            answered `200` before this change and still does - while abuse
 *            of breadth, key length, value length, depth or total volume is
 *            refused with `400`.
 *   headers  LOOSE about unknown keys, because a strict header schema would
 *            reject every real request. `Content-Length` and `Content-Type`
 *            are constrained for shape.
 *   body     refused outright while no permitted verb carries one.
 *   params   strict, and unreachable over HTTP - asserted as a unit below.
 * ---------------------------------------------------------------------- */

describe('V-02 - request shape is validated', () => {
  it('accepts an unknown query parameter - the query schema is a bound, not an allow-list', async () => {
    // Asserted explicitly so nobody "fixes" this suite by expecting a `400`
    // here. Rejecting unknown query keys is NOT one of the response changes
    // this remediation sanctions, and parameter pollution is unreachable on a
    // route that reads no parameter (which is also why `hpp` was declined).
    const response = await request(app).get('/?unexpected=1');

    assert.equal(
      response.status,
      OK_STATUS,
      'an unknown query parameter is accepted; only abuse of the query surface is refused'
    );
  });

  it('refuses a query string with more parameters than the bound permits', async () => {
    // The bound is 32 parameters (`MAX_QUERY_PARAMETERS` in
    // `src/middleware/validation.js`); the probe sends twice that, so the
    // rejection is deterministic rather than borderline.
    const label = `GET / with ${QUERY_PARAMETER_PROBE_COUNT} query parameters`;
    const response = await request(app).get(`/?${buildQuery(QUERY_PARAMETER_PROBE_COUNT)}`);

    assertProblemResponse(response, BAD_REQUEST_STATUS, label);
  });

  it('refuses an over-long query key', async () => {
    // The bound is a 64-character key (`MAX_QUERY_KEY_LENGTH`).
    const label = 'GET / with an over-long query key';
    const response = await request(app).get(`/?${'k'.repeat(QUERY_KEY_PROBE_LENGTH)}=1`);

    assertProblemResponse(response, BAD_REQUEST_STATUS, label);
  });

  it('refuses an over-long query value', async () => {
    // The bound is a 512-character value (`MAX_QUERY_VALUE_LENGTH`).
    const label = 'GET / with an over-long query value';
    const response = await request(app).get(`/?k=${'v'.repeat(QUERY_VALUE_PROBE_LENGTH)}`);

    assertProblemResponse(response, BAD_REQUEST_STATUS, label);
  });

  it('refuses a malformed request header - the header surface is validated too', async () => {
    // The bound is a 512-character `Content-Type` (`MAX_CONTENT_TYPE_LENGTH`).
    // A header this long is not a media type; it is a probe for a buffer or a
    // logger that will mishandle it.
    const label = 'GET / with an over-long Content-Type';
    const response = await request(app)
      .get('/')
      .set('Content-Type', 'x'.repeat(CONTENT_TYPE_PROBE_LENGTH));

    assertProblemResponse(response, BAD_REQUEST_STATUS, label);
  });

  it('refuses a request body on a verb that may not carry one', async () => {
    // The raw helper keeps the probe honest: a body on a `GET` is unusual
    // enough that a client library may decline to send it. `GET` is
    // allow-listed, so the verb guard passes; the JSON parser then produces a
    // body, and the body schema refuses it because no permitted verb carries
    // one - the `400` therefore proves the BODY surface specifically, which
    // the method-guarded `PUT` probe above cannot.
    const label = 'GET / carrying a JSON body';
    const payload = '{"unexpected":"payload"}';
    const response = await rawRequest('GET', '/', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      },
      body: payload,
    });

    assertProblemDocument(response, BAD_REQUEST_STATUS, label);
    assert.ok(
      !response.body.includes('unexpected'),
      `${label}: the rejection must not echo the payload`
    );
  });

  it('validates the path-parameter surface, which no request can reach', async () => {
    // ASVS V5 requires every input surface to be validated, and the path
    // parameters are the one surface no request can exercise: the route table
    // holds exactly one literal route (`GET /`) and the validation middleware
    // is mounted at the root, so `req.params` is always `{}`. A key appearing
    // there would mean a parameterised route had been mounted WITHOUT a
    // schema. The surface is therefore proven as a unit rather than over HTTP,
    // which is the only way to prove it at all.
    assert.equal(typeof validation, 'function', 'the module exports mountable middleware');
    assert.equal(typeof validation.validateRequest, 'function', 'named middleware export');
    assert.equal(typeof validation.validate, 'function', 'schema-set factory export');

    const schemas = validation.schemas;
    assert.deepEqual(
      Object.keys(schemas).sort(),
      ['body', 'headers', 'params', 'query'],
      'one schema per input surface: path, query, headers, body'
    );

    assert.equal(
      schemas.params.safeParse({}).success,
      true,
      'the empty params object every request produces must pass'
    );
    assert.equal(
      schemas.params.safeParse({ id: '1' }).success,
      false,
      'an unexpected path parameter must be refused - the schema is strict'
    );
    assert.equal(
      schemas.body.safeParse(undefined).success,
      true,
      'an absent body must pass while no permitted verb carries one'
    );
    assert.equal(
      schemas.body.safeParse({ unexpected: 'payload' }).success,
      false,
      'a populated body must be refused while no permitted verb carries one'
    );
  });
});

/* -------------------------------------------------------------------------
 * 7 - RFC 9457 problem details and error-path information disclosure.
 *
 * Every rejection above is already asserted to be a problem document. This
 * section makes the sweep explicit across the widest set of statuses this
 * suite can provoke deterministically, because the error path is what an
 * attacker probes: a stack trace, a filesystem path or a dependency version
 * in a `400` discloses more than the success path ever would (CWE-209).
 *
 * `413` and `429` are reachable only by widening the allow-list or by
 * exhausting the budget, so they belong to `rate-limit.test.js` and to the
 * configuration assertions above rather than here.
 * ---------------------------------------------------------------------- */

describe('RFC 9457 - every rejection is a problem document that leaks nothing', () => {
  it('serialises 400, 404 and 405 identically and discloses no internals', async () => {
    const probes = [
      {
        label: '400 from a bounded-out query',
        expected: BAD_REQUEST_STATUS,
        send: () => request(app).get(`/?${buildQuery(QUERY_PARAMETER_PROBE_COUNT)}`),
      },
      {
        label: '404 from an unknown path',
        expected: NOT_FOUND_STATUS,
        send: () => request(app).get('/no-such-route'),
      },
      {
        label: '405 from a non-allow-listed verb',
        expected: METHOD_NOT_ALLOWED_STATUS,
        send: () => request(app).post('/'),
      },
    ];

    for (const probe of probes) {
      const response = await probe.send();
      const document = assertProblemDocument(
        {
          status: response.status,
          headers: response.headers,
          body: typeof response.text === 'string' ? response.text : '',
        },
        probe.expected,
        probe.label
      );

      assert.equal(
        Object.keys(document).length,
        3,
        `${probe.label}: exactly type, title and status - no detail, no instance, no internal member`
      );
    }
  });
});
