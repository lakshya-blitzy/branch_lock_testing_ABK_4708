'use strict';

/**
 * Terminal 404 handler and centralised error handler for the hardened pipeline.
 *
 * Every rejection produced by the pipeline - 400 (schema validation), 404
 * (unknown path), 405 (method allow-list), 413 (body-size ceiling), 429 (rate
 * limiter) and 500 (anything unexpected) - is serialised here, by exactly one
 * code path, as an RFC 9457 "Problem Details for HTTP APIs" document with the
 * `application/problem+json` media type.
 *
 * Information disclosure (CWE-209) is the specific weakness this module closes.
 * The response body is built ONLY from the resolved status code and a static,
 * hard-coded status -> title map. It never carries `err.stack`, `err.message`,
 * `err.type`, `err.code`, the `expected`/`length`/`limit` properties that
 * `body-parser` attaches to a 413, a `zod` issue path or message, a filesystem
 * path, a dependency name or version, or any echo of attacker-supplied input.
 *
 * The RFC 9457 `instance` member is deliberately OMITTED. `instance` would
 * conventionally carry the request URI, and echoing `req.originalUrl` would
 * reflect attacker-controlled content straight back into the response body, so
 * the member is left out entirely rather than sanitised.
 *
 * This module has ZERO imports by design (it is the only stage of the pipeline
 * with no dependency list): the problem documents are built from plain object
 * literals and `JSON.stringify`, and the only diagnostics channel is the
 * `console` global. Per-request and security-event records on stdout are
 * `src/middleware/logging.js`'s responsibility; this module writes to stderr
 * only, and only for faults it would otherwise render undiagnosable.
 *
 * Each handler is standalone: `errorHandler` produces a correct problem
 * document even if `notFoundHandler`, the security middleware or the validation
 * middleware is disabled, so any single stage can be rolled back in isolation.
 */

/** Media type registered by RFC 9457 for problem detail documents. */
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/**
 * RFC 9457's designated default `type` for problems that have no
 * type-specific documentation URI. A fabricated URI that does not resolve
 * would be worse than none at all, so `about:blank` is used unconditionally.
 */
const PROBLEM_TYPE = 'about:blank';

/** Status used whenever the error carries no trustworthy status of its own. */
const FALLBACK_STATUS = 500;

/** Inclusive bounds of the status range this handler is willing to emit. */
const MIN_ERROR_STATUS = 400;
const MAX_ERROR_STATUS = 599;

const NOT_FOUND_STATUS = 404;
const METHOD_NOT_ALLOWED_STATUS = 405;
const SERVER_FAULT_THRESHOLD = 500;

/** Fixed prefix for the stderr-only fault record, so logs are greppable. */
const SERVER_FAULT_PREFIX = '[security] unhandled server fault:';

/**
 * Static status -> title map. Titles are the IANA-registered HTTP reason
 * phrases, which RFC 9457 recommends as the `title` when `type` is
 * `about:blank`. The six titles the pipeline actually produces are listed
 * first; the remainder keep unusual statuses informative without ever
 * consulting a value derived from the request or the error object.
 */
const STATUS_TITLES = Object.freeze({
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  401: 'Unauthorized',
  403: 'Forbidden',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  411: 'Length Required',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  431: 'Request Header Fields Too Large',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

/** Safe generic titles for any status outside the map above. */
const GENERIC_CLIENT_TITLE = 'Client Error';
const GENERIC_SERVER_TITLE = 'Server Error';

/**
 * Keys that must never be copied onto a constructed error, so that a caller
 * supplied `extra` object cannot poison the error's prototype chain.
 */
const UNSAFE_EXTRA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * True only for an integer status this handler is willing to emit. String
 * statuses are rejected rather than coerced: coercion would widen the set of
 * values an upstream stage can steer the response with, for no benefit.
 *
 * @param {*} value candidate status
 * @returns {boolean}
 */
const isEmittableStatus = (value) =>
  Number.isInteger(value) && value >= MIN_ERROR_STATUS && value <= MAX_ERROR_STATUS;

/**
 * Read a property from an untrusted value without ever throwing. The error
 * reaching this middleware may be `null`, a string, a frozen object, or an
 * object whose getters throw; none of those may take the response path down.
 *
 * @param {*} source value to read from
 * @param {string} key property name
 * @returns {*} the property value, or `undefined` if it cannot be read
 */
const readProperty = (source, key) => {
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
    return undefined;
  }
  try {
    return source[key];
  } catch {
    return undefined;
  }
};

/**
 * Resolve the status to emit. `err.status` wins, then `err.statusCode`; any
 * other field is ignored entirely, and anything outside [400, 599] collapses
 * to 500 so an unexpected fault can never be reported as a success.
 *
 * @param {*} err the value passed to `next(err)`
 * @returns {number} an integer status in [400, 599]
 */
const resolveStatus = (err) => {
  const status = readProperty(err, 'status');
  if (isEmittableStatus(status)) {
    return status;
  }
  const statusCode = readProperty(err, 'statusCode');
  if (isEmittableStatus(statusCode)) {
    return statusCode;
  }
  return FALLBACK_STATUS;
};

/**
 * Title for a status, taken only from the static map. `Object.hasOwn` is used
 * so a lookup can never reach an inherited property of the map.
 *
 * @param {number} status integer status in [400, 599]
 * @returns {string} a static, disclosure-safe title
 */
const titleForStatus = (status) => {
  if (Object.hasOwn(STATUS_TITLES, status)) {
    return STATUS_TITLES[status];
  }
  return status >= SERVER_FAULT_THRESHOLD ? GENERIC_SERVER_TITLE : GENERIC_CLIENT_TITLE;
};

/**
 * Build the RFC 9457 document. Only the resolved status and the static map
 * contribute; there is deliberately no `detail` and no `instance` member.
 *
 * @param {number} status integer status in [400, 599]
 * @returns {{type: string, title: string, status: number}}
 */
const buildProblemDocument = (status) => ({
  type: PROBLEM_TYPE,
  title: titleForStatus(status),
  status,
});

/**
 * Construct an `Error` carrying an HTTP status, for the other pipeline stages
 * and for `notFoundHandler`. The `message` exists for logs only and is never
 * serialised into a response, because response bodies are built exclusively
 * from `buildProblemDocument`.
 *
 * @param {number} status intended HTTP status; anything not in [400, 599] becomes 500
 * @param {Object} [extra] additional own properties to attach, for example
 *   `{ allow: 'GET, HEAD' }` on a 405
 * @returns {Error} error with `status` set
 */
const httpError = (status, extra) => {
  const resolved = isEmittableStatus(status) ? status : FALLBACK_STATUS;
  const err = new Error(titleForStatus(resolved));

  if (extra !== null && typeof extra === 'object') {
    for (const key of Object.keys(extra)) {
      if (UNSAFE_EXTRA_KEYS.has(key)) {
        continue;
      }
      try {
        err[key] = extra[key];
      } catch {
        // A non-writable property on the target is not worth failing over.
      }
    }
  }

  // Assigned last so `extra` can never override the resolved invariants.
  err.status = resolved;
  // Defence in depth: if this module's handler were ever unmounted, Express's
  // own final handler consults `expose` before revealing a message.
  err.expose = false;

  if (typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(err, httpError);
  }

  return err;
};

/**
 * Terminal 404 stage, mounted after the route table and before `errorHandler`.
 * It writes nothing itself - it delegates a 404 so that every rejection in the
 * service is serialised by the single code path in `errorHandler`.
 *
 * @param {Object} req request (unused; present for the Express signature)
 * @param {Object} res response (unused; this stage never writes)
 * @param {Function} next Express continuation
 * @returns {void}
 */
const notFoundHandler = (req, res, next) => {
  const err = httpError(NOT_FOUND_STATUS);
  if (typeof next === 'function') {
    next(err);
    return;
  }
  // Called outside Express: throwing keeps the rejection observable rather
  // than silently returning a request with no response.
  throw err;
};

/**
 * True when the response already carries the named header, so an upstream
 * stage's value is never clobbered.
 *
 * @param {Object} res response
 * @param {string} name header name
 * @returns {boolean}
 */
const hasHeader = (res, name) => {
  if (typeof res.getHeader !== 'function') {
    return false;
  }
  try {
    return res.getHeader(name) !== undefined;
  } catch {
    return false;
  }
};

/**
 * Restore `Allow` on a 405 as a belt-and-braces measure. The method allow-list
 * sets the header itself before delegating and also attaches `err.allow`; this
 * only fills the gap if that stage is disabled, and never overwrites a value
 * that is already present.
 *
 * @param {*} err delegated error
 * @param {Object} res response
 * @param {number} status resolved status
 * @returns {void}
 */
const applyAllowHeader = (err, res, status) => {
  if (status !== METHOD_NOT_ALLOWED_STATUS) {
    return;
  }
  const allow = readProperty(err, 'allow');
  if (typeof allow !== 'string' || allow.trim() === '') {
    return;
  }
  if (hasHeader(res, 'Allow')) {
    return;
  }
  try {
    if (typeof res.set === 'function') {
      res.set('Allow', allow);
    } else if (typeof res.setHeader === 'function') {
      res.setHeader('Allow', allow);
    }
  } catch {
    // A failure to decorate must never prevent the problem document itself.
  }
};

/**
 * Record a server-side fault on stderr, never in the response and never on
 * stdout. Losing the stack of a genuine 500 would make it undiagnosable.
 *
 * @param {*} err delegated error
 * @param {number} status resolved status
 * @returns {void}
 */
const logServerFault = (err, status) => {
  if (status < SERVER_FAULT_THRESHOLD) {
    return;
  }
  const stack = readProperty(err, 'stack');
  if (typeof stack === 'string' && stack !== '') {
    console.error(SERVER_FAULT_PREFIX, stack);
    return;
  }
  let description = '[unserialisable error value]';
  try {
    description = String(err);
  } catch {
    // Keep the placeholder; a throwing `toString` is not a reason to crash.
  }
  console.error(SERVER_FAULT_PREFIX, description);
};

/**
 * Write the serialised problem document. The Express path is
 * `res.status().set().send()`, which leaves every header set upstream intact -
 * helmet's twelve security headers, `Vary`/`Access-Control-*` from cors,
 * `Retry-After`/`RateLimit`/`RateLimit-Policy` from the rate limiter and
 * `Allow` on a 405. `res.writeHead` with a fresh header object and
 * `res.removeHeader` are therefore never used. Express appends a charset, so
 * the observed header is `application/problem+json; charset=utf-8`.
 *
 * The raw-`http` branch is only reached when the response is not an Express
 * response; it sets headers individually, for the same reason.
 *
 * @param {Object} req request, for the HEAD check on the raw branch
 * @param {Object} res response
 * @param {number} status resolved status
 * @param {string} payload serialised problem document
 * @returns {void}
 */
const sendProblemDocument = (req, res, status, payload) => {
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    // `res.send` correctly omits the body for HEAD, so HEAD is not special-cased.
    res.status(status).set('Content-Type', PROBLEM_MEDIA_TYPE).send(payload);
    return;
  }

  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', PROBLEM_MEDIA_TYPE);
    res.setHeader('Content-Length', Buffer.byteLength(payload));
  }
  const method = readProperty(req, 'method');
  if (typeof method === 'string' && method.toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  res.end(payload);
};

/**
 * Centralised error handler.
 *
 * The four-parameter signature is MANDATORY: Express identifies
 * error-handling middleware by function arity, so dropping `next` - even
 * though the common path never calls it - would silently demote this to
 * ordinary middleware and send every rejection to Express's default HTML
 * error page, which leaks a stack trace. `next` is retained for that reason
 * and is genuinely used on both delegation paths below.
 *
 * @param {*} err value passed to `next(err)`; may be any type
 * @param {Object} req request
 * @param {Object} res response
 * @param {Function} next Express continuation, used only when this handler cannot respond
 * @returns {void}
 */
const errorHandler = (err, req, res, next) => {
  const status = resolveStatus(err);
  logServerFault(err, status);

  if (res === null || typeof res !== 'object') {
    if (typeof next === 'function') {
      next(err);
    }
    return;
  }

  // Headers are already on the wire: responding again would throw, so the
  // error is delegated for Express to abort the connection.
  if (res.headersSent) {
    if (typeof next === 'function') {
      next(err);
    }
    return;
  }

  applyAllowHeader(err, res, status);

  const payload = JSON.stringify(buildProblemDocument(status));

  try {
    sendProblemDocument(req, res, status, payload);
  } catch (sendError) {
    const sendStack = readProperty(sendError, 'stack');
    console.error(SERVER_FAULT_PREFIX, sendStack || 'response write failed');
    if (typeof next === 'function') {
      next(err);
    }
  }
};

/**
 * `notFound` and `problemDetailsHandler` are aliases of the two handlers above,
 * provided so the application factory can mount them under either name.
 */
module.exports = {
  notFoundHandler,
  errorHandler,
  httpError,
  notFound: notFoundHandler,
  problemDetailsHandler: errorHandler,
};
