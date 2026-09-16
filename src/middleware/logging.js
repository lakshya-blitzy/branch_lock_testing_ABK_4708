'use strict';

/**
 * Structured request and security-event audit logging.
 *
 * Closes finding V-08 (CWE-778, Insufficient Logging): before this module the
 * only observability in the process was the single startup line in
 * `server.js`, so a rate-limit rejection, an origin denial, a method rejection
 * or a validation failure was completely invisible. Every control added by the
 * hardened pipeline now emits a machine-parsable record, which is what makes
 * an attack in progress detectable rather than silent.
 *
 * Design constraints, each of them deliberate:
 *
 * - ZERO dependencies. This module requires nothing at all — not a package,
 *   not a Node core module, not a sibling module. A dedicated logger (`pino`
 *   was the candidate) was evaluated and declined: adding a dependency to a
 *   security fix expands the supply-chain surface for a benefit this service
 *   does not need. The accepted trade-off is no log rotation and no transport
 *   features; records go to stdout and the process supervisor owns the rest.
 *   Only `JSON.stringify`, `Date`, `String`, `Number`, `Object` and `console`
 *   are used.
 *
 * - `console.log`, not `process.stdout.write`. `console.log` writes *through*
 *   `process.stdout.write`, so a test spying on either channel observes the
 *   record, whereas a direct `process.stdout.write` is invisible to a
 *   `console.log` spy. One single-line JSON object is emitted per record:
 *   never multi-line, never pretty-printed.
 *
 * - No configuration. `config/security.js` is the single source of truth for
 *   this service and exposes no logging setting, so this module reads no
 *   environment variable and offers no level/silence switch. Output is
 *   unconditional and uniform.
 *
 * - The response is never touched. No header is set, no status code is
 *   changed, no body is written. `GET /` must keep returning exactly the
 *   14 bytes `Hello, World!\n`.
 *
 * - Nothing here may ever throw. Every serialisation and every property read
 *   is guarded, and each exported function returns `undefined`. A failure to
 *   log must never propagate into the request path, and every pipeline stage
 *   has to stay independently disableable: any call site of this module can be
 *   removed with no other change.
 *
 * - Every externally-sourced value is sanitised before serialisation, which is
 *   a control and not hygiene. Request paths, `Origin` values and client
 *   addresses are attacker-controlled; unbounded or control-character-bearing
 *   values let an attacker forge log lines (CWE-117, log injection) or flood
 *   the log. Credential-bearing fields are redacted outright, and request
 *   bodies are never logged.
 *
 * No logic in this module assumes a local client: the default bind address of
 * `127.0.0.1` is a mitigating factor, not a control.
 */

/* -------------------------------------------------------------------------- *
 * Bounds — every value that reaches a record is length- and count-bounded so
 * a hostile request cannot dominate either the log or the request path.
 * -------------------------------------------------------------------------- */

/** Fallback ceiling for any string with no more specific bound. */
const MAX_STRING_LENGTH = 256;

/** Ceiling for the security event name. */
const MAX_EVENT_LENGTH = 64;

/** Ceiling for an HTTP method token. */
const MAX_METHOD_LENGTH = 16;

/** Ceiling for a request path (path plus query string). */
const MAX_PATH_LENGTH = 256;

/** Ceiling for a client address. Generous enough for IPv6 and IPv4-mapped forms. */
const MAX_IP_LENGTH = 64;

/** Ceiling for a detail key name. */
const MAX_KEY_LENGTH = 48;

/** Maximum number of caller-supplied detail keys copied into a record. */
const MAX_DETAIL_KEYS = 12;

/** Appended to any value that had to be cut short, so truncation is visible. */
const TRUNCATION_MARKER = '...[truncated]';

/** Substituted for a credential-bearing value, so the attempt stays visible. */
const REDACTED = '[REDACTED]';

/** Used when a caller supplies an event name that is not a usable string. */
const UNSPECIFIED_EVENT = 'security.unspecified';

/**
 * Record fields owned by this module. A caller-supplied detail may never
 * overwrite them, otherwise a crafted detail object could rewrite the event
 * name or the record discriminator and defeat downstream log analysis.
 */
const RESERVED_FIELDS = Object.freeze(['ts', 'kind', 'level', 'event']);

/**
 * Credential-bearing field names, normalised to lowercase alphanumerics. Any
 * detail key matching one of these is redacted rather than serialised. Request
 * bodies and the `authorization`, `cookie`, `set-cookie` and
 * `proxy-authorization` headers must never reach the log; the remaining
 * entries are defence in depth against a caller passing a secret by a
 * different name.
 */
const DENIED_KEYS = Object.freeze([
  'authorization',
  'proxyauthorization',
  'wwwauthenticate',
  'cookie',
  'cookies',
  'setcookie',
  'body',
  'requestbody',
  'rawbody',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'privatekey',
  'credentials',
  'authentication',
  'sessionid',
  'session',
]);

/**
 * The stable security-event names. Frozen so the call sites in
 * `src/middleware/security.js` and `src/middleware/validation.js` cannot drift
 * from them, and so downstream log analysis can match on exact strings.
 *
 * - RATE_LIMIT_EXCEEDED — the `express-rate-limit` handler (V-03)
 * - CORS_ORIGIN_DENIED  — the `cors` origin callback (V-06)
 * - METHOD_NOT_ALLOWED  — the top-level method allow-list (V-02, V-07)
 * - VALIDATION_FAILED   — the schema validation adapter (V-02)
 *
 * @type {Readonly<{RATE_LIMIT_EXCEEDED: string, CORS_ORIGIN_DENIED: string,
 *                  METHOD_NOT_ALLOWED: string, VALIDATION_FAILED: string}>}
 */
const SECURITY_EVENTS = Object.freeze({
  RATE_LIMIT_EXCEEDED: 'security.rate_limit_exceeded',
  CORS_ORIGIN_DENIED: 'security.cors_origin_denied',
  METHOD_NOT_ALLOWED: 'security.method_not_allowed',
  VALIDATION_FAILED: 'security.validation_failed',
});

/**
 * Coerce a value into a bounded, control-character-free string.
 *
 * Strings, finite numbers and booleans are accepted; anything else (object,
 * array, function, symbol, bigint, null, undefined) yields `undefined` so the
 * caller omits the field entirely. This is what makes circular and exotic
 * objects unreachable from the serialiser.
 *
 * ASCII C0 controls, DEL and the C1 range are stripped rather than escaped, so
 * a CR/LF payload cannot survive into the record at all (CWE-117). The scan is
 * bounded, so a multi-megabyte value costs a fixed amount of work.
 *
 * @param {unknown} value Candidate value, typically attacker-controlled.
 * @param {number} [maxLength] Ceiling for the result, excluding the marker.
 * @returns {string|undefined} Sanitised string, or `undefined` if unusable.
 */
const safeString = (value, maxLength) => {
  try {
    let text;
    if (typeof value === 'string') {
      text = value;
    } else if (typeof value === 'number') {
      text = Number.isFinite(value) ? String(value) : undefined;
    } else if (typeof value === 'boolean') {
      text = String(value);
    }
    if (typeof text !== 'string') {
      return undefined;
    }

    const limit =
      Number.isInteger(maxLength) && maxLength > 0 ? maxLength : MAX_STRING_LENGTH;
    // Bounded scan: stripped characters consume budget too, so a payload made
    // entirely of control characters cannot force an unbounded loop.
    const budget = limit * 4;
    let scanned = 0;
    let truncated = false;
    let out = '';

    // Iterating by code point never splits a surrogate pair, so truncation
    // cannot leave a lone surrogate behind.
    for (const character of text) {
      if (scanned >= budget) {
        truncated = true;
        break;
      }
      scanned += 1;

      const code = character.codePointAt(0);
      const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      if (isControl) {
        continue;
      }
      if (out.length + character.length > limit) {
        truncated = true;
        break;
      }
      out += character;
    }

    return truncated ? out + TRUNCATION_MARKER : out;
  } catch {
    // A hostile `toString`/`Symbol.iterator` must not reach the request path.
    return undefined;
  }
};

/**
 * Normalise a key name for deny-list comparison: lowercase, alphanumerics
 * only, so `Set-Cookie`, `set_cookie` and `SETCOOKIE` all collapse to the same
 * token.
 *
 * @param {string} key Sanitised key name.
 * @returns {string} Normalised token.
 */
const normaliseKey = (key) => {
  let out = '';
  for (const character of key.toLowerCase()) {
    const code = character.codePointAt(0);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isLetter = code >= 0x61 && code <= 0x7a;
    if (isDigit || isLetter) {
      out += character;
    }
  }
  return out;
};

/**
 * Copy caller-supplied details into a flat, bounded, primitives-only object.
 *
 * Only own enumerable keys are considered, at most `MAX_DETAIL_KEYS` of them.
 * Values are kept only when they are a string, a finite number, a boolean or
 * `null`; every other value — including nested objects, arrays and bigints —
 * is skipped, which simultaneously bounds the record, keeps `JSON.stringify`
 * total and makes a circular reference unreachable. Reserved fields are
 * refused and credential-bearing keys are redacted.
 *
 * @param {unknown} details Caller-supplied detail object.
 * @returns {Object<string, string|number|boolean|null>} Safe detail fields.
 */
const sanitiseDetails = (details) => {
  const safe = {};
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return safe;
  }

  let keys;
  try {
    keys = Object.keys(details);
  } catch {
    return safe;
  }

  let copied = 0;
  for (const key of keys) {
    if (copied >= MAX_DETAIL_KEYS) {
      break;
    }

    try {
      const safeKey = safeString(key, MAX_KEY_LENGTH);
      if (!safeKey) {
        continue;
      }
      const normalised = normaliseKey(safeKey);
      if (RESERVED_FIELDS.indexOf(normalised) !== -1) {
        continue;
      }
      if (DENIED_KEYS.indexOf(normalised) !== -1) {
        safe[safeKey] = REDACTED;
        copied += 1;
        continue;
      }

      // A getter on the supplied object may throw; the surrounding try/catch
      // keeps that contained to this single key.
      const value = details[key];
      if (typeof value === 'string') {
        const text = safeString(value, MAX_STRING_LENGTH);
        if (typeof text === 'string') {
          safe[safeKey] = text;
          copied += 1;
        }
      } else if (typeof value === 'number') {
        if (Number.isFinite(value)) {
          safe[safeKey] = value;
          copied += 1;
        }
      } else if (typeof value === 'boolean') {
        safe[safeKey] = value;
        copied += 1;
      } else if (value === null) {
        safe[safeKey] = null;
        copied += 1;
      }
      // Anything else is deliberately dropped.
    } catch {
      // Skip the offending key and keep going; logging never fails loudly.
    }
  }

  return safe;
};

/**
 * Serialise and emit exactly one line.
 *
 * `JSON.stringify` escapes any residual control character, so the emitted line
 * can never contain a raw newline: one record is always one line. The write is
 * guarded because `console.log` may have been replaced by a test spy that
 * throws, and that must not reach the request path.
 *
 * @param {Object} record Fully sanitised record.
 * @returns {undefined}
 */
const writeRecord = (record) => {
  try {
    const line = JSON.stringify(record);
    if (typeof line === 'string') {
      console.log(line);
    }
  } catch {
    // Unserialisable record: drop it rather than disturb the response.
  }
  return undefined;
};

/**
 * Build the leading fields shared by every record.
 *
 * @param {string} kind Record discriminator, `'request'` or `'security'`.
 * @returns {{ts: string, kind: string}} Base record.
 */
const baseRecord = (kind) => {
  let ts;
  try {
    ts = new Date().toISOString();
  } catch {
    ts = '';
  }
  return { ts: ts, kind: kind };
};

/**
 * Record a security-relevant rejection.
 *
 * Emits a single-line JSON object carrying an ISO-8601 `ts`, the
 * `kind: 'security'` discriminator, `level: 'warn'`, the literal `event` name
 * and the sanitised details. Both the discriminator and the event name are
 * always present so downstream matching can key on either.
 *
 * Callers pass already-chosen primitive fields, for example:
 *
 *   logSecurityEvent(SECURITY_EVENTS.CORS_ORIGIN_DENIED, {
 *     ip: req.ip,
 *     origin: req.headers.origin,
 *   });
 *
 * `req.ip` is included deliberately — abuse detection (rate-limit saturation,
 * origin probing, method probing) is the whole point of this audit trail — and
 * is sanitised like every other value, because it can be influenced by headers
 * under some proxy configurations. Never pass a request body or a
 * credential-bearing header; both are refused here as well.
 *
 * Never throws, whatever it is handed.
 *
 * @param {string} event One of the `SECURITY_EVENTS` values.
 * @param {Object} [details] Flat object of primitive fields.
 * @returns {undefined} Always.
 */
const logSecurityEvent = (event, details) => {
  try {
    const name = safeString(event, MAX_EVENT_LENGTH);
    const record = baseRecord('security');
    record.level = 'warn';
    record.event = name ? name : UNSPECIFIED_EVENT;

    const safeDetails = sanitiseDetails(details);
    for (const key of Object.keys(safeDetails)) {
      record[key] = safeDetails[key];
    }

    writeRecord(record);
  } catch {
    // An audit-trail failure must never become a request failure.
  }
  return undefined;
};

/**
 * Per-request access logger.
 *
 * Position-insensitive by construction: the record is emitted from a one-shot
 * `finish` listener on the response, so the FINAL status code is captured no
 * matter where `src/app.js` mounts this middleware. That matters because the
 * pipeline's first ordering rule reserves the first position for `helmet()`;
 * this logger writes no header and sets no status, so it neither competes with
 * that rule nor changes the response in any way.
 *
 * `next()` is called exactly once, synchronously and unconditionally — even if
 * listener attachment fails — and it is called outside the guard so a
 * downstream synchronous throw still propagates to the error handler.
 *
 * Emitted fields: ISO-8601 `ts`, `kind: 'request'`, `event: 'http.request'`,
 * `method`, `path`, `status`, integer `durationMs`, and `ip` when available.
 * The request body and all credential-bearing headers are never read.
 *
 * @param {Object} req Incoming request.
 * @param {Object} res Outgoing response.
 * @param {Function} next Express continuation.
 * @returns {undefined} Always.
 */
const requestLogger = (req, res, next) => {
  const startedAt = Date.now();

  try {
    const attach =
      res && typeof res.once === 'function'
        ? res.once.bind(res)
        : res && typeof res.on === 'function'
          ? res.on.bind(res)
          : undefined;

    if (attach) {
      attach('finish', () => {
        try {
          const record = baseRecord('request');
          record.event = 'http.request';

          const method = safeString(req?.method, MAX_METHOD_LENGTH);
          record.method = method ? method : 'UNKNOWN';

          const rawPath = req ? (req.originalUrl || req.url) : undefined;
          const path = safeString(rawPath, MAX_PATH_LENGTH);
          record.path = typeof path === 'string' ? path : '';

          const status = res ? Number(res.statusCode) : Number.NaN;
          record.status = Number.isFinite(status) ? status : 0;

          const elapsed = Date.now() - startedAt;
          record.durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;

          const ip = safeString(req?.ip, MAX_IP_LENGTH);
          if (ip) {
            record.ip = ip;
          }

          writeRecord(record);
        } catch {
          // The response has already been sent; there is nothing to recover.
        }
      });
    }
  } catch {
    // Listener attachment failed: continue without an access record rather
    // than failing the request.
  }

  if (typeof next === 'function') {
    next();
  }
  return undefined;
};

/**
 * Dual CommonJS export shape, mirroring `src/app.js`: the default export is
 * the request logger so it can be mounted directly, and the named forms are
 * available for the middleware modules that only need the event recorder.
 */
module.exports = requestLogger;
module.exports.requestLogger = requestLogger;
module.exports.logSecurityEvent = logSecurityEvent;
module.exports.SECURITY_EVENTS = SECURITY_EVENTS;
