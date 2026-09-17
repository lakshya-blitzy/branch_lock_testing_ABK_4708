'use strict';

/**
 * Express 5 application factory - the hardened request pipeline.
 *
 * WHAT THIS FILE REPLACES
 * -----------------------
 * The whole of this service's request handling used to be the five-line
 * inline callback at `server.js` lines 6-10:
 *
 *     const server = http.createServer((req, res) => {
 *       res.statusCode = 200;
 *       res.setHeader('Content-Type', 'text/plain');
 *       res.end('Hello, World!\n');
 *     });
 *
 * That handler never read `req`. It inspected no method, no path, no header
 * and no body, so every request was "valid" by construction: `TRACE /`
 * returned `200`, `DELETE /../../etc/passwd` returned `200`, a 100,000-byte
 * `PUT` was accepted unbounded, 300 sequential requests returned 300 x `200`,
 * and an `OPTIONS /` bearing `Origin: https://evil.example` returned `200`
 * with zero `Access-Control-*` headers and no `Vary: Origin`. It set exactly
 * one response header, so no defensive header existed at all.
 *
 * This factory replaces that callback with a layered, order-sensitive
 * pipeline in which each of the six requested controls is a discrete,
 * independently testable and independently removable stage.
 *
 * CALL FORM
 * ---------
 * CommonJS, because `package.json` declares no `type` field. `server.js`
 * obtains the application with:
 *
 *     const app = require('./src/app')();
 *
 * and the named form is exactly equivalent:
 *
 *     const app = require('./src/app').createApp();
 *
 * A FACTORY, not a shared singleton, for two reasons. Each call builds a new
 * application with its own security stages, and therefore its own in-memory
 * rate-limit store - which is what lets the rate-limit suite exhaust a budget
 * without leaking that state into any other test. It also matches the shape
 * `runner.js` already expects of `require('./server')` (L15/L36/L57), whose
 * contract `server.js` moves toward at no risk to this file.
 *
 * Requiring this module is FREE of side effects: no port is bound, no socket
 * is opened, no timer is armed and nothing is written to stdout. Every stage
 * is constructed inside `createApp()`.
 *
 * NO TRANSPORT CONCERNS LIVE HERE
 * -------------------------------
 * There is deliberately no `http`, no `https`, no `listen`, no host, no port
 * and no TLS anywhere in this file. Choosing the listener and enforcing the
 * `TLSv1.2` floor is `server.js`'s responsibility; this file owns only what
 * happens to a request once it has arrived.
 *
 * THE PIPELINE
 * ------------
 *   1  helmet()                    twelve security headers, `X-Powered-By`
 *                                  removed ............................ V-01
 *   -  requestLogger               structured audit trail ............. V-08
 *   2  cors()                      origin allow-list, deny-all until
 *                                  configured, `Vary: Origin` always ... V-06
 *   3  express-rate-limit          `429` + `Retry-After` + draft-8
 *                                  `RateLimit` headers ................ V-03
 *   4  method allow-list           `GET`/`HEAD` only; every other verb
 *                                  is `405` + `Allow` ........... V-02, V-07
 *   5  body parsers with limits    hard byte ceiling, `413` on
 *                                  oversize ........................... V-02
 *   6  zod schema validation       `400` on violation ................. V-02
 *   7  route table                 `GET /` -> `200` `Hello, World!\n`
 *   8  terminal 404                unknown paths
 *   9  error handler               RFC 9457 `application/problem+json`,
 *                                  never a stack trace ......... CWE-209
 *
 * Stages 1-5 come from `./middleware/security`, stage 6 from
 * `./middleware/validation`, stages 8-9 from `./middleware/errors`, and the
 * audit trail from `./middleware/logging`. This file mounts them in the
 * mandatory order and defines stage 7.
 *
 * THE THREE ORDERING RULES - load-bearing, not cosmetic
 * ----------------------------------------------------
 * Each was derived empirically from a working prototype. Getting any one of
 * them wrong produces a service that APPEARS hardened but is not.
 *
 * Rule 1 - `helmet` must be FIRST. Mounted next to the route handler it would
 * decorate only SUCCESSFUL responses. Mounted first, all twelve headers are
 * present on `400`, `404`, `405`, `413`, `429` and `500` responses too. Error
 * responses are precisely what an attacker probes most, so header coverage
 * there is not optional. Nothing may be mounted ahead of it.
 *
 * Rule 2 - `cors` must PRECEDE the method allow-list. `cors` short-circuits
 * EVERY `OPTIONS` request with `204`, including preflights from denied
 * origins and requests carrying no `Origin` at all. Were the method
 * allow-list to run first it would answer `OPTIONS` with `405` and preflight
 * would break for legitimately allow-listed origins, defeating R6.
 *
 * Rule 3 - the method allow-list must be TOP-LEVEL `app.use` middleware and
 * NEVER a catch-all route. An Express 5 wildcard route does not match the
 * root path, so an `app.all('/*splat', ...)` implementation produced
 * `TRACE / -> 404` where `405` was required - leaving Cross-Site Tracing
 * (V-07) open while every test that probed a NON-root path still passed. Only
 * top-level middleware sees every request regardless of path. This file
 * therefore registers exactly one route, `GET /`, and no wildcard at all.
 *
 * ROLLBACK (AAP 0.5.3.3)
 * ----------------------
 * The mount sequence below is a flat list of `app.use` calls, one per stage,
 * each labelled with the control it provides and the finding it closes. No
 * stage depends on another's side effects, so any single line can be
 * commented out - or skipped conditionally - without disturbing the rest.
 * Thresholds and policies are environment-driven inside the middleware
 * modules, so the usual rollback needs no code change here at all.
 *
 * STANDARDS APPLIED
 * -----------------
 * OWASP Secure Headers Project (the twelve-header set, guaranteed on every
 * response by Rule 1); OWASP Top 10 2021 A01 Broken Access Control (the
 * method and origin allow-lists), A03 Injection (the schema validation
 * stage) and A05 Security Misconfiguration (the header set and the
 * fail-closed defaults); OWASP ASVS v4 V5 (validation) and V12/V13 (API and
 * web service); OWASP API Security Top 10 API4 Unrestricted Resource
 * Consumption (the limiter and the body ceiling); RFC 9457 (the problem
 * documents); the IETF RateLimit header fields draft-8 (the throttling
 * headers); and least privilege throughout - `GET, HEAD` only, origins
 * denied by default.
 *
 * FINDINGS CLOSED OR ENABLED HERE: V-01, V-02, V-03, V-06, V-07, V-08, and
 * the CWE-209 error-disclosure concern.
 */

const express = require('express');

const { securityMiddlewares } = require('./middleware/security');
const validateRequest = require('./middleware/validation');
const { notFoundHandler, errorHandler } = require('./middleware/errors');
const requestLogger = require('./middleware/logging');

/* -------------------------------------------------------------------------
 * The preserved response contract.
 *
 * AAP 0.10.3 makes this a MUST-MAINTAIN and
 * `test/security/behavior-preservation.test.js` enforces it mechanically:
 * hardening the service must not change what it returns.
 * ---------------------------------------------------------------------- */

/** The one and only route. No wildcard is registered anywhere (Rule 3). */
const ROOT_PATH = '/';

/** Success status, unchanged from `server.js` line 7. */
const OK_STATUS = 200;

/**
 * The response body, byte-for-byte as `server.js` line 9 wrote it: exactly
 * 14 bytes, trailing newline included. The newline is PART OF THE CONTRACT -
 * it is written verbatim, never through a helper that might trim it, pad it
 * or re-serialise it.
 */
const GREETING_BODY = 'Hello, World!\n';

/**
 * Response media type, as `server.js` line 8 set it.
 *
 * Express normalises this to `text/plain; charset=utf-8`. That is an
 * EXPECTED and benign delta (AAP 0.8.3.4), not a defect: the body stays
 * byte-identical and only the header value gains the charset parameter,
 * which is a small improvement because it removes encoding-sniffing
 * ambiguity. Likewise Express adds a weak `ETag`; both are left alone.
 */
const GREETING_CONTENT_TYPE = 'text/plain';

/* -------------------------------------------------------------------------
 * The security chain contract.
 * ---------------------------------------------------------------------- */

/**
 * Number of middleware functions `securityMiddlewares()` is contracted to
 * return: stages 1-4 contribute one each and stage 5 contributes two (the
 * JSON and URL-encoded parsers), so five stages arrive as six functions.
 *
 * This count is asserted rather than assumed. A silently dropped security
 * stage is far more dangerous than a loud startup failure, so if
 * `./middleware/security` ever changes shape this factory refuses to build
 * an application at all instead of quietly serving requests through a
 * shorter pipeline.
 */
const EXPECTED_SECURITY_STAGE_COUNT = 6;

/**
 * Index of the `helmet` stage within that array. It is the first element,
 * which is what allows the audit-trail stage to be mounted immediately after
 * it without violating Ordering Rule 1.
 */
const HEADER_STAGE_INDEX = 0;

/**
 * Build and verify the security stages for one application.
 *
 * `securityMiddlewares()` returns a FRESH array on every call, so each
 * application receives its own rate-limit store rather than sharing one
 * process-wide. The returned order is the mandatory order documented above
 * and frozen in the sibling module's own stage list.
 *
 * @returns {Function[]} The six security middleware, in the mandatory order.
 * @throws {TypeError} When the sibling module's contract has drifted - a
 *   wrong stage count, a non-array, or a non-function entry.
 */
const resolveSecurityStages = () => {
  const stages = securityMiddlewares();

  if (!Array.isArray(stages) || stages.length !== EXPECTED_SECURITY_STAGE_COUNT) {
    throw new TypeError(
      'src/middleware/security.js must supply exactly ' +
        EXPECTED_SECURITY_STAGE_COUNT +
        ' middleware in the mandatory order; refusing to build an application ' +
        'with an incomplete security pipeline.'
    );
  }

  for (const stage of stages) {
    if (typeof stage !== 'function') {
      throw new TypeError(
        'src/middleware/security.js supplied a non-function security stage; ' +
          'refusing to build an application with an unusable security pipeline.'
      );
    }
  }

  return stages;
};

/* -------------------------------------------------------------------------
 * Stage 7 - the route table.
 * ---------------------------------------------------------------------- */

/**
 * The single route handler, preserving the original contract exactly.
 *
 * The media type is set before the body is written so Express does not
 * default the response to `text/html`, and the body string is passed through
 * verbatim. `res.json` is deliberately not used: it would rewrite the body
 * as a JSON document and break the 14-byte guarantee.
 *
 * No `try`/`catch` wraps this. A throw here must propagate to the
 * centralised error handler rather than being swallowed into a bespoke
 * response that would bypass the RFC 9457 serialisation.
 *
 * `HEAD /` is served by this same handler - Express derives it from the
 * `GET` route and strips the body, and the method allow-list permits it - so
 * no separate `HEAD` handler is registered.
 *
 * @param {Object} req Express request (unused; the response is constant).
 * @param {Object} res Express response.
 * @returns {void}
 */
const greetingHandler = (req, res) => {
  res.type(GREETING_CONTENT_TYPE).status(OK_STATUS).send(GREETING_BODY);
};

/* -------------------------------------------------------------------------
 * The factory.
 * ---------------------------------------------------------------------- */

/**
 * Build a fully hardened Express 5 application.
 *
 * The mount sequence below IS the security posture of this service; its order
 * is the mandatory order, and the three rules in this file's header explain
 * why each position is what it is.
 *
 * @returns {Object} A configured Express application, ready for a listener.
 * @throws {TypeError} When the security chain's contract has drifted.
 */
const createApp = () => {
  const stages = resolveSecurityStages();
  const headerStage = stages[HEADER_STAGE_INDEX];
  const remainingStages = stages.slice(HEADER_STAGE_INDEX + 1);

  const app = express();

  // Defence in depth for `X-Powered-By`. The helmet stage already removes the
  // header; disabling it at the application level means it never reaches the
  // wire even if that stage is rolled back.
  app.disable('x-powered-by');

  // Stage 1 - security response headers ............................... V-01
  // FIRST, and nothing ahead of it (Ordering Rule 1), so all twelve headers
  // reach error responses as well as successful ones.
  app.use(headerStage);

  // Audit trail - structured request and security-event logging ....... V-08
  // Mounted here, immediately after the header stage, because a stage that
  // short-circuits - the `405` from the method allow-list, the `413` from a
  // body ceiling, the `429` from the limiter - is never reached by anything
  // mounted behind it. From this position every request is recorded,
  // rejections included, which is the entire point of the audit trail. The
  // logger writes no header, sets no status and touches no body, so it
  // neither competes with Rule 1 nor perturbs the 14-byte contract; it
  // captures the FINAL status from a one-shot `finish` listener.
  app.use(requestLogger);

  // Stages 2-5 - the remainder of the security chain, in the mandatory
  // order fixed by `./middleware/security`:
  //   2  cors() origin allow-list, deny-all until configured ......... V-06
  //      Ahead of the method allow-list (Ordering Rule 2) so preflight is
  //      answered before any verb is filtered.
  //   3  express-rate-limit, `429` + `Retry-After` + draft-8 headers .. V-03
  //   4  method allow-list, top-level and never a route (Rule 3),
  //      `405` + `Allow: GET, HEAD` ................................ V-02, V-07
  //   5  body parsers with a hard byte ceiling, `413` on oversize ..... V-02
  app.use(...remainingStages);

  // Stage 6 - zod schema validation of path, query, headers and body .. V-02
  // After the body parsers, because a body cannot be validated before it is
  // parsed, and before the route table, so no unvalidated input ever reaches
  // application logic. Violations are delegated as `400`.
  app.use(validateRequest);

  // Stage 7 - the route table. Exactly one route, no wildcard (Rule 3).
  app.get(ROOT_PATH, greetingHandler);

  // Stage 8 - terminal 404 for unknown paths, after every route.
  app.use(notFoundHandler);

  // Stage 9 - centralised error handler, LAST.
  // Express identifies an error handler by its `(err, req, res, next)`
  // arity: drop the fourth parameter and it silently degrades to ordinary
  // middleware, sending every rejection to Express's default HTML error page
  // - which leaks a stack trace. `errorHandler` keeps that arity, and it is
  // the single code path that serialises all of `400`, `404`, `405`, `413`,
  // `429` and `500` as RFC 9457 `application/problem+json` carrying no stack
  // trace, no filesystem path, no dependency name and no echo of input.
  app.use(errorHandler);

  return app;
};

/**
 * Default export is the factory itself, so `require('./src/app')()` builds an
 * application; the named form is provided for callers that prefer to be
 * explicit about what they are invoking.
 */
module.exports = createApp;
module.exports.createApp = createApp;
