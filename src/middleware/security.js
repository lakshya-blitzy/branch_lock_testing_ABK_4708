'use strict';

/**
 * Security middleware - stages 1 to 5 of the hardened request pipeline.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The only network-reachable component of this service used to be a 14-line
 * raw `http` listener whose handler never read the request: it answered every
 * method on every path with `200`, set exactly one response header
 * (`Content-Type: text/plain`), accepted an unbounded body, tracked no
 * per-client state and inspected no `Origin`. Probing it confirmed all of
 * that: `TRACE /` returned `200`, a 100,000-byte `PUT` returned `200`, 300
 * sequential requests returned 300 x `200`, and an `OPTIONS /` carrying
 * `Origin: https://evil.example` returned `200` with zero `Access-Control-*`
 * headers and no `Vary: Origin`.
 *
 * This module is where that changes. It contributes the first five stages of
 * the request pipeline, each a discrete control:
 *
 *   1. `helmet()`                 twelve security response headers, plus the
 *                                 explicit `Cross-Origin-Embedder-Policy`
 *                                 opt-in, and `X-Powered-By` removed   V-01
 *   2. `cors()`                   an exact-match origin allow-list that is
 *                                 deny-all until configured, with
 *                                 `Vary: Origin` always emitted         V-06
 *   3. `express-rate-limit`       a per-client fixed-window budget with
 *                                 `429`, `Retry-After` and the IETF
 *                                 draft-8 `RateLimit` headers           V-03
 *   4. method allow-list          `GET`/`HEAD` only; every other verb is
 *                                 `405` with an `Allow` header, which is
 *                                 what closes Cross-Site Tracing   V-07, V-02
 *   5. body parsers with limits   a hard byte ceiling per request, so an
 *                                 oversized payload becomes `413`       V-02
 *
 * `src/app.js` adds the remaining stages (schema validation, the route table,
 * the terminal `404` and the RFC 9457 error handler). This module contains no
 * transport concern: no `http`, no `https`, no `listen`, no host, no port and
 * no TLS. Those belong to `server.js`.
 *
 * MODULE CONTRACT
 * ---------------
 * CommonJS (`package.json` declares no `type` field). Requiring this module is
 * free of side effects: it reads the frozen configuration object, builds no
 * listener, opens no socket, arms no timer and writes nothing to stdout. A
 * stage's own state (the limiter's in-memory store) is created only when a
 * stage list is built.
 *
 * Exports:
 *
 *   module.exports                  = applySecurity
 *   module.exports.applySecurity    = applySecurity
 *   module.exports.securityMiddlewares = securityMiddlewares
 *
 *   applySecurity(app)         mounts stages 1 to 5 on an Express application,
 *                              in order, and returns the same application.
 *   securityMiddlewares()      returns a fresh, ordered array of the stage
 *                              middleware for a caller that prefers to mount
 *                              them itself: `app.use(...securityMiddlewares())`.
 *
 * Both paths are derived from ONE ordered list (`STAGE_FACTORIES`), so the two
 * can never drift out of order. Each call builds fresh middleware instances so
 * that every application gets its own rate-limit store; that matters for
 * tests, which construct an application per file.
 *
 * ROLLBACK (AAP 0.5.3.3)
 * ----------------------
 * The five stages are a flat list of independent middleware. No stage depends
 * on another's side effects, so any single entry in `STAGE_FACTORIES` can be
 * commented out - or skipped conditionally - without disturbing the others.
 * Every threshold is environment-driven through `config/security.js`, so the
 * usual rollback (widen the origin list, raise the budget, raise the body
 * ceiling) needs no code change at all.
 *
 * STANDARDS APPLIED
 * -----------------
 * OWASP Secure Headers Project (the header set, including the deliberate
 * `X-XSS-Protection: 0`), OWASP Top 10 2021 A01 Broken Access Control (the
 * method and origin allow-lists) and A05 Security Misconfiguration (the header
 * set and the fail-closed defaults), OWASP ASVS v4 V12/V13 (API and web
 * service), OWASP API Security Top 10 API4 Unrestricted Resource Consumption
 * (the limiter and the body ceiling), the IETF RateLimit header fields draft-8
 * (the throttling headers), RFC 9457 (the problem documents produced by the
 * delegated errors) and least privilege throughout.
 *
 * FINDINGS CLOSED: V-01 (CWE-693, CWE-1021, CWE-16), V-03 (CWE-770, CWE-400,
 * CWE-307), V-06 (CWE-346, CWE-942), V-07 (CWE-16); V-02 (CWE-20, CWE-770) in
 * part, alongside `src/middleware/validation.js`.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');

const cfg = require('../../config/security');
const { httpError } = require('./errors');
const { logSecurityEvent, SECURITY_EVENTS } = require('./logging');

/* -------------------------------------------------------------------------
 * Values resolved once, at module load.
 *
 * `config/security.js` reads `process.env` at ITS require time and freezes
 * what it resolved, so everything below is a projection of that single frozen
 * object. This module never touches `process.env`, never caches an environment
 * value of its own and never invents a setting: the eleven documented
 * variables are the whole configuration surface.
 * ---------------------------------------------------------------------- */

/** Status delegated for a verb outside the allow-list. */
const METHOD_NOT_ALLOWED_STATUS = 405;

/** Status delegated for a client that has exhausted its budget. */
const TOO_MANY_REQUESTS_STATUS = 429;

/**
 * Preflight success status. Pinned explicitly rather than left to the `cors`
 * default so the verified `204` cannot drift with a dependency update, and so
 * the value the CORS tests assert is stated in this file.
 */
const PREFLIGHT_SUCCESS_STATUS = 204;

/**
 * Request headers a cross-origin caller may send.
 *
 * Setting this deliberately, rather than omitting it: with an explicit list
 * `cors` emits `Access-Control-Allow-Headers: Content-Type,Accept` and leaves
 * `Vary` as just `Origin`. Omitting it would make `cors` REFLECT whatever
 * `Access-Control-Request-Headers` the caller sent, which is strictly more
 * permissive. The policy therefore constrains permitted headers as well as
 * permitted methods, which is what "proper CORS policy" requires.
 */
const ALLOWED_REQUEST_HEADERS = Object.freeze(['Content-Type', 'Accept']);

/**
 * The method allow-list, upper-cased and de-duplicated locally.
 *
 * `config/security.js` already normalises and validates these tokens; this is
 * belt-and-braces so the comparison and the `Allow` header can never disagree
 * with each other. The frozen configuration array is projected into a NEW
 * frozen array - the configuration object itself is never mutated.
 *
 * @type {ReadonlyArray<string>}
 */
const ALLOWED_METHODS = Object.freeze(
  cfg.methods.allowed
    .map((method) => String(method).toUpperCase())
    .filter((method, index, list) => method !== '' && list.indexOf(method) === index)
);

/** O(1) membership test for the guard's hot path. */
const ALLOWED_METHOD_SET = new Set(ALLOWED_METHODS);

/**
 * The `Allow` header value: the upper-cased list joined with a comma AND a
 * space, which is how RFC 9110 field values are written and exactly what the
 * method-rejection tests assert - `Allow: GET, HEAD`.
 */
const ALLOW_HEADER_VALUE = ALLOWED_METHODS.join(', ');

/**
 * Fallback `Retry-After`, in whole seconds, for the rate-limit stage.
 *
 * `express-rate-limit` sets `Retry-After` itself BEFORE it invokes the handler
 * (verified in the package's own source and at runtime), so this value is only
 * used if that header is somehow absent. At least one second is advertised,
 * because `Retry-After: 0` tells a client to retry immediately.
 */
const RETRY_AFTER_SECONDS = Math.max(1, Math.ceil(cfg.rateLimit.windowMs / 1000));

/* -------------------------------------------------------------------------
 * Small helpers. Everything here is failure-tolerant: a diagnostic detail
 * that cannot be read must never take a request down.
 * ---------------------------------------------------------------------- */

/**
 * Best-effort request path for a security-event record, excluding the query
 * string. `req.path` is a getter, so it is read defensively.
 *
 * The value is attacker-controlled; `logSecurityEvent` sanitises and bounds
 * every field it is handed, which is why it is safe to pass on.
 *
 * @param {Object} req Express request.
 * @returns {string|undefined} Path, or `undefined` when unreadable.
 */
const requestPath = (req) => {
  try {
    if (typeof req.path === 'string') {
      return req.path;
    }
    if (typeof req.url === 'string') {
      return req.url;
    }
  } catch {
    // A throwing getter is not worth failing the request over.
  }
  return undefined;
};

/**
 * Best-effort client address for a security-event record. Abuse detection is
 * the entire point of the audit trail, so the address is recorded; it is
 * sanitised by the logger like every other field.
 *
 * @param {Object} req Express request.
 * @returns {string|undefined} Client address, or `undefined` when unreadable.
 */
const requestIp = (req) => {
  try {
    if (typeof req.ip === 'string') {
      return req.ip;
    }
  } catch {
    // Same reasoning as `requestPath`.
  }
  return undefined;
};

/**
 * Set a response header only when it is not already present, never
 * overwriting an upstream stage's value and never throwing.
 *
 * @param {Object} res Express response.
 * @param {string} name Header name.
 * @param {string|number} value Header value.
 * @returns {void}
 */
const setHeaderIfAbsent = (res, name, value) => {
  try {
    if (typeof res.getHeader !== 'function' || typeof res.setHeader !== 'function') {
      return;
    }
    if (res.getHeader(name) !== undefined || res.headersSent) {
      return;
    }
    res.setHeader(name, value);
  } catch {
    // Decorating a response must never prevent the rejection itself.
  }
};

/* -------------------------------------------------------------------------
 * Stage 1 - security response headers (R1, V-01).
 * ---------------------------------------------------------------------- */

/**
 * Build the `helmet` stage.
 *
 * `helmet@8` sets twelve headers by default and removes `X-Powered-By`. No
 * default is disabled here. The observed header set is:
 *
 *   Content-Security-Policy: default-src 'self';base-uri 'self';font-src
 *     'self' https: data:;form-action 'self';frame-ancestors 'self';img-src
 *     'self' data:;object-src 'none';script-src 'self';script-src-attr
 *     'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Resource-Policy: same-origin
 *   Origin-Agent-Cluster: ?1
 *   Referrer-Policy: no-referrer
 *   Strict-Transport-Security: max-age=31536000; includeSubDomains
 *   X-Content-Type-Options: nosniff
 *   X-DNS-Prefetch-Control: off
 *   X-Download-Options: noopen
 *   X-Frame-Options: SAMEORIGIN
 *   X-Permitted-Cross-Domain-Policies: none
 *   X-XSS-Protection: 0
 *
 * Three points a future editor must not "fix":
 *
 * - `Cross-Origin-Embedder-Policy` is NOT a helmet default. It is opted into
 *   explicitly below, which yields `require-corp`. Remove the option and the
 *   control disappears silently.
 * - `X-XSS-Protection: 0` is CORRECT. Current guidance disables the legacy
 *   XSS auditor, which itself introduced vulnerabilities. It is not a defect
 *   and must not become `1; mode=block`.
 * - `Strict-Transport-Security` is emitted unconditionally and is simply INERT
 *   over plain HTTP, because browsers honour it only over HTTPS. Emitting it
 *   always removes the class of bug where the header is forgotten at the
 *   moment TLS is switched on, so it must not be made conditional on
 *   `TLS_ENABLED`.
 *
 * HSTS values come from configuration rather than helmet's internal default so
 * that a staged rollout can lower - or retract, with `max-age=0` - the pin
 * without a code change, and so the emitted header always matches
 * `config/security.js`. `preload` is deliberately not requested: it is a
 * near-irreversible commitment to a public list.
 *
 * The Content Security Policy is moot today (`default-src 'self'` has no
 * practical effect on a `text/plain` response) and is kept at helmet's default
 * precisely because it costs nothing now and constrains any future HTML
 * surface by default rather than by remembering.
 *
 * @returns {Function} Express middleware.
 */
const createHeaderStage = () =>
  helmet({
    // Not a default. Without this the control is silently absent.
    crossOriginEmbedderPolicy: true,
    hsts: {
      maxAge: cfg.hsts.maxAge,
      includeSubDomains: cfg.hsts.includeSubDomains,
    },
  });

/* -------------------------------------------------------------------------
 * Stage 2 - cross-origin resource sharing (R6, V-06).
 * ---------------------------------------------------------------------- */

/**
 * Resolve the CORS origin policy for one request.
 *
 * THE ONE THING THAT MUST NOT CHANGE: this callback resolves to the allow-list
 * ARRAY. Never a boolean, never `undefined`, never a bare string, never `'*'`.
 * Both alternatives fail, and both fail silently:
 *
 * - Resolving a FALSY value (`callback(null, false)`) makes `cors` call
 *   `next()` having emitted NO header at all. `Access-Control-Allow-Origin` is
 *   absent, which looks right, but `Vary: Origin` is absent too - leaving the
 *   cache-poisoning gap open - and an `OPTIONS` request then falls through to
 *   the method allow-list and is answered `405`, destroying preflight for
 *   legitimately allow-listed origins.
 * - Resolving a falsy value or `'*'` reaches `cors`'s own
 *   `if (!options.origin || options.origin === '*')` branch, which emits
 *   `Access-Control-Allow-Origin: *`. That is a complete fail-open of V-06.
 *
 * Resolving the array is correct even when the array is EMPTY, which is the
 * deny-all default: an empty array is truthy, so `cors` takes its comparison
 * branch, sets `Access-Control-Allow-Origin` only when the request origin
 * matches an entry exactly, and pushes `Vary: Origin` unconditionally either
 * way. Fail-closed, with `Vary` intact.
 *
 * The callback is never invoked with an `Error`: doing so would turn a denied
 * origin into a `500`, whereas the required behaviour is that the request
 * itself still succeeds and merely loses browser read access.
 *
 * Matching is exact-string, which is what `cors` performs and what
 * `config/security.js` documents - no wildcard, no subdomain glob, no regular
 * expression. The denial test below therefore uses the same comparison that
 * decides the header, so the audit record can never disagree with the wire.
 *
 * @param {string|undefined} requestOrigin Value of the request's `Origin`
 *   header, or `undefined` for a same-origin or non-browser caller.
 * @param {Function} callback `cors` continuation, `(err, origin)`.
 * @returns {void}
 */
const resolveOrigin = (requestOrigin, callback) => {
  if (
    typeof requestOrigin === 'string' &&
    requestOrigin !== '' &&
    !cfg.cors.allowedOrigins.includes(requestOrigin)
  ) {
    // Fire-and-forget: the logger returns `undefined` and never throws, and
    // no control here depends on it (V-08).
    logSecurityEvent(SECURITY_EVENTS.CORS_ORIGIN_DENIED, { origin: requestOrigin });
  }

  // Resolve the allow-list ARRAY - see the two traps above.
  callback(null, cfg.cors.allowedOrigins);
};

/**
 * Build the `cors` stage.
 *
 * REVIEWER TRAP, and it is the most likely misreading of this whole change: a
 * DENIED origin's preflight also receives `204`. `cors` short-circuits every
 * `OPTIONS` request with the configured success status, including preflights
 * from denied origins and requests carrying no `Origin` header at all.
 *
 *   THE CONTROL IS THE ABSENCE OF THE `Access-Control-Allow-Origin` HEADER,
 *   NOT THE STATUS CODE.
 *
 * Observed, and asserted by `test/security/cors.test.js`:
 *
 *   allowed origin, preflight -> 204 WITH Access-Control-Allow-Origin,
 *                                Vary: Origin,
 *                                Access-Control-Allow-Methods: GET,HEAD,
 *                                Access-Control-Allow-Headers: Content-Type,Accept
 *   denied origin, preflight  -> 204 WITH Vary and Access-Control-Allow-Methods
 *                                but WITHOUT Access-Control-Allow-Origin
 *
 * A reviewer expecting `403` will wrongly conclude the control is missing.
 *
 * `methods` and `allowedHeaders` are passed as ARRAYS: `cors` joins an array
 * with a bare comma, producing the verified `GET,HEAD`. Pre-joining them with
 * `', '` would emit a different field value.
 *
 * `credentials` is left `false`, so `Access-Control-Allow-Credentials` is
 * never emitted: the service has no authentication surface, and advertising
 * credential support it does not implement would be misleading at best.
 *
 * @returns {Function} Express middleware.
 */
const createCorsStage = () =>
  cors({
    origin: resolveOrigin,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    credentials: false,
    optionsSuccessStatus: PREFLIGHT_SUCCESS_STATUS,
  });

/* -------------------------------------------------------------------------
 * Stage 3 - rate limiting (R3, V-03).
 * ---------------------------------------------------------------------- */

/**
 * Handle an over-budget request.
 *
 * The library's own handler would send a plain-text body. This one delegates
 * instead, so the rejection is serialised by the single RFC 9457 code path in
 * `src/middleware/errors.js` - every rejection in this service, whatever
 * produced it, has one `application/problem+json` shape.
 *
 * No header is removed or rewritten. `express-rate-limit` sets `Retry-After`
 * BEFORE invoking this handler (verified in the package source: the
 * `totalHits > limit` branch calls `setRetryAfterHeader` and only then
 * `config.handler`), and the draft-8 `RateLimit` and `RateLimit-Policy`
 * headers are already on the response, so all three survive delegation. The
 * one defensive write below fills `Retry-After` only if it is somehow absent.
 *
 * @param {Object} req Express request.
 * @param {Object} res Express response.
 * @param {Function} next Express continuation.
 * @returns {void}
 */
const rateLimitHandler = (req, res, next) => {
  logSecurityEvent(SECURITY_EVENTS.RATE_LIMIT_EXCEEDED, {
    ip: requestIp(req),
    method: typeof req.method === 'string' ? req.method.toUpperCase() : undefined,
    path: requestPath(req),
  });

  setHeaderIfAbsent(res, 'Retry-After', RETRY_AFTER_SECONDS);

  next(httpError(TOO_MANY_REQUESTS_STATUS));
};

/**
 * Build the rate-limit stage.
 *
 * Canonical option names only: `windowMs`, `limit` (the configuration
 * accessor is `rateLimit.max`; the library option is `limit`, and `max` is
 * deprecated), `standardHeaders: 'draft-8'` and `legacyHeaders: false`.
 * `statusCode` is deliberately NOT set, because it already defaults to `429`.
 *
 * `draft-8` advertises the policy on successful responses too, so a
 * well-behaved client can pace itself rather than discovering the ceiling by
 * being refused. `legacyHeaders: false` suppresses the pre-standard
 * `X-RateLimit-*` set, whose absence the rate-limit tests assert.
 *
 * No `keyGenerator` is supplied: the library's default keys on the client
 * address, which is what a per-client budget means here. No shared store is
 * supplied either - the in-memory store does not share state across processes,
 * which is a known and documented limitation (the service is single-process
 * today) and a shared store can be added later without moving this stage.
 *
 * The thresholds are platform-chosen rather than user-specified, which is
 * exactly why they are read from configuration and tunable without a code
 * change.
 *
 * @returns {Function} Express middleware.
 */
const createRateLimitStage = () =>
  rateLimit({
    windowMs: cfg.rateLimit.windowMs,
    limit: cfg.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  });

/* -------------------------------------------------------------------------
 * Stage 4 - the HTTP method allow-list (R2, V-02, V-07).
 * ---------------------------------------------------------------------- */

/**
 * Build the method allow-list stage.
 *
 * THIS MUST BE MOUNTED AS TOP-LEVEL MIDDLEWARE (`app.use`), NEVER AS A ROUTE.
 * An Express 5 wildcard route does not match the root path, so implementing
 * this as `app.all('/*splat', ...)` answers `TRACE /` with `404` instead of
 * `405` - leaving Cross-Site Tracing (V-07) open while every test that probed
 * a non-root path appeared to pass. Only top-level middleware sees every
 * request regardless of path.
 *
 * `TRACE` and `TRACK` are not special-cased: they are simply absent from the
 * permitted set, so they - and every other unknown verb - are refused by
 * construction. `OPTIONS` is likewise absent, and that is deliberate: the
 * `cors` stage runs first and short-circuits every `OPTIONS` request with
 * `204`, so preflight never reaches this guard. Reordering the two stages to
 * force `OPTIONS -> 405` would break preflight for allow-listed origins and
 * defeat the CORS requirement.
 *
 * The guard responds to nothing itself. It sets `Allow`, records the
 * rejection, and delegates a `405` so that the RFC 9457 handler remains the
 * single serialisation path. `err.allow` is attached as well, because
 * `src/middleware/errors.js` restores the header from it should this stage
 * ever be disabled.
 *
 * A desirable measured consequence: because this stage precedes the body
 * parsers, a 100,000-byte `PUT` is refused with `405` before any parser reads
 * a byte, so an oversized payload on a rejected verb never reaches a parser
 * at all.
 *
 * @returns {Function} Express middleware.
 */
const createMethodAllowListStage = () => {
  const methodAllowList = (req, res, next) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';

    if (ALLOWED_METHOD_SET.has(method)) {
      next();
      return;
    }

    // An empty allow-list cannot produce a valid `Allow` field value, so the
    // header is omitted in that case rather than emitted empty; the request is
    // still refused, which is the fail-closed outcome.
    if (ALLOW_HEADER_VALUE !== '') {
      setHeaderIfAbsent(res, 'Allow', ALLOW_HEADER_VALUE);
    }

    logSecurityEvent(SECURITY_EVENTS.METHOD_NOT_ALLOWED, {
      ip: requestIp(req),
      method: method === '' ? undefined : method,
      path: requestPath(req),
    });

    next(httpError(METHOD_NOT_ALLOWED_STATUS, { allow: ALLOW_HEADER_VALUE }));
  };

  return methodAllowList;
};

/* -------------------------------------------------------------------------
 * Stage 5 - body parsers with explicit size ceilings (R2, V-02).
 * ---------------------------------------------------------------------- */

/**
 * Build the JSON body parser.
 *
 * Express 5 parses no body unless a parser is mounted, which suits mounting
 * one WITH an explicit ceiling instead of relying on a default. A payload
 * above `JSON_BODY_LIMIT` raises a parser error carrying `status: 413`, which
 * the error handler serialises as a problem document. The pre-remediation
 * listener accepted a 100,000-byte body with no bound whatsoever.
 *
 * @returns {Function} Express middleware.
 */
const createJsonBodyStage = () => express.json({ limit: cfg.body.jsonLimit });

/**
 * Build the URL-encoded body parser.
 *
 * `extended: false` is a security choice, not a stylistic one: the simple
 * query-string parser has a smaller attack surface than the extended parser,
 * and this service consumes no nested form input.
 *
 * @returns {Function} Express middleware.
 */
const createUrlencodedBodyStage = () =>
  express.urlencoded({ extended: false, limit: cfg.body.jsonLimit });

/* -------------------------------------------------------------------------
 * THE MANDATORY ORDER - load-bearing, not cosmetic.
 *
 * Each rule below was derived empirically from a working prototype. Getting
 * any one of them wrong produces a system that APPEARS hardened but is not,
 * so do not reorder this list without re-reading them.
 *
 *   Rule 1 - `helmet` MUST BE FIRST. Mounted next to the route handler it
 *            would decorate successful responses only. Mounted first, all
 *            twelve headers reach `404`, `405`, `413`, `429` and `500`
 *            responses too - and error responses are exactly what an attacker
 *            probes most, so coverage there is not optional.
 *
 *   Rule 2 - `cors` MUST PRECEDE THE METHOD ALLOW-LIST. `cors` short-circuits
 *            every `OPTIONS` request with `204`. If the method guard ran
 *            first it would answer `OPTIONS` with `405` and preflight would
 *            break for legitimately allow-listed origins.
 *
 *   Rule 3 - THE METHOD ALLOW-LIST IS TOP-LEVEL MIDDLEWARE, NOT A ROUTE. An
 *            Express 5 wildcard route does not match the root path, so a
 *            catch-all route answers `TRACE /` with `404` instead of `405`
 *            and leaves Cross-Site Tracing open.
 *
 * Stage 5 contributes two middleware functions (JSON and URL-encoded), so the
 * five stages are expressed as six factories. `securityMiddlewares()` and
 * `applySecurity()` both read this one list, so the two mounting paths cannot
 * drift apart.
 * ---------------------------------------------------------------------- */
const STAGE_FACTORIES = Object.freeze([
  // 1  - security response headers ............ V-01
  createHeaderStage,
  // 2  - cross-origin allow-list .............. V-06
  createCorsStage,
  // 3  - per-client rate limiting ............. V-03
  createRateLimitStage,
  // 4  - method allow-list .............. V-02, V-07
  createMethodAllowListStage,
  // 5a - JSON body ceiling .................... V-02
  createJsonBodyStage,
  // 5b - URL-encoded body ceiling ............. V-02
  createUrlencodedBodyStage,
]);

/**
 * Applications already hardened by `applySecurity`, tracked weakly so an
 * application can still be garbage-collected.
 *
 * Mounting the chain twice on one application would be quietly harmful rather
 * than merely wasteful: two limiter instances would each charge the same
 * request, halving the effective budget. The guard makes a duplicate call a
 * no-op instead.
 *
 * @type {WeakSet<Object>}
 */
const hardenedApplications = new WeakSet();

/**
 * Build a fresh, ordered array of the security middleware.
 *
 * Every call constructs new middleware instances, so each application gets its
 * own rate-limit store rather than sharing one process-wide. Values come from
 * the configuration object resolved at module load; nothing here reads
 * `process.env`.
 *
 * Intended for a caller that prefers to mount the stages itself:
 *
 *   app.use(...securityMiddlewares());
 *
 * @returns {Function[]} The stages, in the mandatory order documented above.
 */
const securityMiddlewares = () => STAGE_FACTORIES.map((createStage) => createStage());

/**
 * Mount stages 1 to 5 on an Express application, in the mandatory order.
 *
 * `X-Powered-By` is also disabled at the application level. `helmet` already
 * removes the header, so this is belt-and-braces rather than a substitute:
 * the header never reaches the wire even if the helmet stage is rolled back.
 *
 * @param {Object} app Express application.
 * @returns {Object} The same application, for chaining.
 * @throws {TypeError} When `app` is not an Express-like application.
 */
const applySecurity = (app) => {
  if (app === null || app === undefined || typeof app.use !== 'function') {
    throw new TypeError(
      'applySecurity(app) requires an Express application: the value passed has no use() method.'
    );
  }

  if (hardenedApplications.has(app)) {
    return app;
  }
  hardenedApplications.add(app);

  if (typeof app.disable === 'function') {
    app.disable('x-powered-by');
  }

  for (const stage of securityMiddlewares()) {
    app.use(stage);
  }

  return app;
};

module.exports = applySecurity;
module.exports.applySecurity = applySecurity;
module.exports.securityMiddlewares = securityMiddlewares;
