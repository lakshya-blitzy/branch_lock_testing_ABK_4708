'use strict';

/**
 * Security configuration - the single source of truth for every security
 * setting this service applies.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The only network-reachable component of this service previously carried no
 * security control whatsoever. The remediation adds six of them - security
 * response headers, input validation, rate limiting, HTTPS transport, a
 * cross-origin allow-list and a clean dependency set - as discrete stages of
 * one request pipeline. Origin allow-lists, rate budgets, body ceilings and
 * TLS paths all differ per environment, so every threshold those stages need
 * is resolved HERE from `process.env` instead of being embedded in the
 * listener or the middleware (OWASP ASVS v4, V14 Configuration). Hard-coding
 * them would produce a service that is either unusable in production or
 * insecure in development; no other module may carry a security literal.
 *
 * MODULE CONTRACT
 * ---------------
 * CommonJS (`package.json` declares no `type` field) with ZERO imports: this
 * module reads `process.env` directly and needs neither a third-party package
 * nor a core module. It exports ONE deeply frozen object, evaluated once at
 * require time. There is deliberately no factory, no `load(env)` function and
 * no reload API: a consumer that needs different values runs in a child
 * process with a different environment (as the TLS verification does) or
 * clears `require.cache`. Freezing the exported object together with every
 * nested object and array means a careless - or compromised - consumer cannot
 * mutate security policy at runtime.
 *
 * Beyond validation this module has no side effects: it performs no I/O, opens
 * no socket, arms no timer, writes nothing to stdout or stderr and never
 * mutates `process.env`. Diagnostics belong to `src/middleware/logging.js`.
 * Throwing on misconfiguration is not a side effect - it is the fail-closed
 * gate, and it fires at require time so a misconfigured deployment refuses to
 * start rather than running with a silently weakened policy.
 *
 * ACCESSOR PATHS - a binding interface, not a suggestion
 * -----------------------------------------------------
 *   host                    string       HOST
 *   port                    number       PORT
 *   cors.allowedOrigins     string[]     ALLOWED_ORIGINS
 *   methods.allowed         string[]     ALLOWED_METHODS
 *   rateLimit.windowMs      number       RATE_LIMIT_WINDOW_MS   (milliseconds)
 *   rateLimit.max           number       RATE_LIMIT_MAX         (requests per
 *                                                               window per client)
 *   body.jsonLimit          string       JSON_BODY_LIMIT        (byte size)
 *   tls.enabled             boolean      TLS_ENABLED
 *   tls.keyPath             string|null  TLS_KEY_PATH           (path only)
 *   tls.certPath            string|null  TLS_CERT_PATH          (path only)
 *   tls.minVersion          string       hard-coded 'TLSv1.2' - NO variable
 *   hsts.maxAge             number       HSTS_MAX_AGE           (seconds)
 *   hsts.includeSubDomains  boolean      hard-coded true - NO variable
 *
 * Unset TLS paths are `null`, never `undefined`, so that they stay visible in
 * `JSON.stringify(require('./config/security'))` - `JSON.stringify` drops
 * `undefined` members, which would make that inspection misleading.
 *
 * THE ELEVEN ENVIRONMENT VARIABLES AND THEIR DEFAULTS
 * ---------------------------------------------------
 * Exactly eleven variables are read - no more, no fewer. There is no
 * `NODE_ENV`, no log level, no database URL, no session secret and no
 * authentication setting, because no such surface exists in this service.
 *
 *   HOST                  '127.0.0.1'   bind address
 *   PORT                  3000          bind port (0-65535; 0 = OS-assigned)
 *   ALLOWED_ORIGINS       (empty)       comma-separated exact origins; empty
 *                                       means DENY every cross-origin caller
 *   ALLOWED_METHODS       'GET, HEAD'   comma-separated HTTP method allow-list
 *   RATE_LIMIT_WINDOW_MS  900000        accounting window, 15 minutes
 *   RATE_LIMIT_MAX        100           requests per window per client (>= 1)
 *   JSON_BODY_LIMIT       '1kb'         hard request-body ceiling
 *   TLS_ENABLED           false         opt-in HTTPS listener
 *   TLS_KEY_PATH          null          filesystem path of the private key
 *   TLS_CERT_PATH         null          filesystem path of the certificate
 *   HSTS_MAX_AGE          31536000      Strict-Transport-Security age, 1 year
 *
 * EVERY DEFAULT IS THE RESTRICTIVE OUTCOME
 * ----------------------------------------
 * A variable that is unset, empty or whitespace-only is treated as ABSENT and
 * its default applies. That rule is safe only because each default above is
 * the restrictive baseline, so falling back can never fail open: an
 * unconfigured deployment denies all cross-origin callers, admits only `GET`
 * and `HEAD`, throttles at 100 requests per 15 minutes and caps bodies at one
 * kilobyte. A present-but-unparseable security budget is never guessed - it
 * throws (OWASP API Security Top 10, API8 Security Misconfiguration).
 *
 * AUTHORITY
 * ---------
 * `.env.example`, the configuration table in `README.md` and
 * `docs/security/hardening.md` must reproduce these variable names and
 * defaults character for character. Where any of them diverges from this
 * file, THIS FILE WINS and the other document is the defect.
 *
 * CONSUMERS
 * ---------
 *   server.js                     - host, port, tls.*
 *   src/middleware/security.js    - cors.allowedOrigins, methods.allowed,
 *                                   rateLimit.*, body.jsonLimit, hsts.*
 *   src/middleware/validation.js  - methods.allowed, body.jsonLimit
 *   test/security/*.test.js       - asserts the resolved values and the
 *                                   fail-closed rejections
 *
 * FINDINGS SUPPORTED: V-01 (missing security headers), V-02 (absent input
 * validation / unbounded body), V-03 (no rate limiting), V-04 (cleartext-only
 * transport), V-06 (CORS entirely unconfigured).
 */

/* -------------------------------------------------------------------------
 * Defaults. Each literal below is a security decision, not a convenience.
 * ---------------------------------------------------------------------- */

/**
 * Bind address. Reproduces the pre-remediation listener's literal exactly, so
 * behaviour is preserved while the hard-coded value leaves application code.
 *
 * SECURITY NOTE, and it matters: loopback binding is a MITIGATING FACTOR, NOT
 * A CONTROL. It is one string away from being a public bind, it confers
 * nothing on a shared or containerised host, and it is irrelevant to the
 * supply-chain findings. No setting or default in this module may depend on
 * the bind address being loopback, and none does.
 */
const DEFAULT_HOST = '127.0.0.1';

/** Bind port. Reproduces the pre-remediation listener's literal exactly. */
const DEFAULT_PORT = 3000;

/**
 * Method allow-list. Least privilege: only the two verbs the service actually
 * implements. Everything else is answered `405` with an `Allow` header, which
 * is what closes Cross-Site Tracing (V-07) - `TRACE` is simply not a member of
 * this set, and cannot be made one (see FORBIDDEN_METHODS).
 */
const DEFAULT_ALLOWED_METHODS = ['GET', 'HEAD'];

/** Rate-limit accounting window: 15 minutes, expressed in milliseconds. */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 900000;

/** Rate-limit budget: 100 requests per window per client. */
const DEFAULT_RATE_LIMIT_MAX = 100;

/**
 * Request-body ceiling, in the byte-size form the body parsers accept.
 *
 * `1kb` is a genuine tightening, not an inherited default: the service
 * consumes no request body at all (only `GET` and `HEAD` are permitted), the
 * pre-remediation listener accepted a 100,000-byte `PUT` body with no bound
 * whatsoever, and 1kb sits roughly a hundredfold below that payload and well
 * below the parsers' own 100kb default. It bounds per-request memory
 * consumption (CWE-770, and OWASP API4 Unrestricted Resource Consumption).
 */
const DEFAULT_JSON_BODY_LIMIT = '1kb';

/**
 * `Strict-Transport-Security` age in seconds: one year, with subdomains
 * included, matching the header the security middleware emits.
 *
 * HSTS is emitted unconditionally and is simply INERT over plain HTTP -
 * browsers honour it only over HTTPS. That is deliberate rather than a
 * defect: it removes the class of bug where the header is forgotten at the
 * moment TLS is switched on.
 */
const DEFAULT_HSTS_MAX_AGE = 31536000;

/**
 * TLS protocol floor. Hard-coded, exposed here only so the floor is stated in
 * exactly one place. It is NOT a twelfth setting: there is no environment
 * variable for it under any name, because per OWASP A02 Cryptographic
 * Failures the floor must not be weakenable by configuration.
 */
const TLS_MIN_VERSION = 'TLSv1.2';

/** `includeSubDomains` is likewise hard-coded and has no variable. */
const HSTS_INCLUDE_SUBDOMAINS = true;

/* -------------------------------------------------------------------------
 * Validation constants.
 * ---------------------------------------------------------------------- */

/** Highest port number a TCP socket can bind. `0` is permitted (ephemeral). */
const MAX_PORT = 65535;

/**
 * Verbs whose rejection IS a control and which therefore can never be
 * admitted through configuration. The method allow-list stays configurable so
 * a legitimate verb can be added without a code change; that flexibility does
 * not extend to these three. `TRACE`/`TRACK` are Cross-Site Tracing (V-07) and
 * `CONNECT` would invite proxy abuse.
 */
const FORBIDDEN_METHODS = Object.freeze(['TRACE', 'TRACK', 'CONNECT']);

/**
 * Shape of an acceptable method token. Standard and WebDAV verbs (`GET`,
 * `MKCOL`, `M-SEARCH`) all match. The point is exclusion rather than
 * inclusion: carriage returns, line feeds, spaces, colons and `*` cannot pass,
 * so an operator-supplied value can never be shaped like a header injection
 * when the middleware joins this list into the `Allow` header.
 */
const METHOD_TOKEN_PATTERN = /^[A-Z][A-Z0-9-]*$/;

/** A whole trimmed string that is a base-10 integer, with an optional sign. */
const INTEGER_PATTERN = /^[+-]?[0-9]+$/;

/**
 * Byte-size grammar accepted by the body parsers: a number with an optional
 * decimal part and an optional unit suffix. Matching this pattern is a
 * fail-closed requirement, not cosmetic validation - the parsers treat a size
 * they cannot parse as NO LIMIT AT ALL, so an unchecked typo in
 * `JSON_BODY_LIMIT` would silently restore the unbounded body (V-02).
 */
const BYTE_SIZE_PATTERN = /^[0-9]+(\.[0-9]+)? *(b|kb|mb|gb|tb|pb)?$/i;

/** Literal that would admit every origin, and is therefore never accepted. */
const WILDCARD = '*';

/** Values read as "on". Anything outside the two sets below throws. */
const AFFIRMATIVE_VALUES = Object.freeze(['true', '1', 'yes', 'on']);

/**
 * Values read as "off". Accepting an explicit negative is what lets
 * `.env.example` and a deployment's own `.env` state `TLS_ENABLED=false`
 * without the service refusing to start, while a typo such as `ture` or a
 * vague `maybe` still throws instead of being silently downgraded to
 * cleartext.
 */
const NEGATIVE_VALUES = Object.freeze(['false', '0', 'no', 'off']);

/* -------------------------------------------------------------------------
 * Private readers. Every one of them applies the absence rule identically:
 * unset, empty or whitespace-only means ABSENT, and the documented default
 * applies. Values are trimmed before use. No reader has a permissive
 * fallback, and no reader touches anything outside `process.env`.
 * ---------------------------------------------------------------------- */

/**
 * Trimmed raw value of an environment variable, or `''` when it is absent.
 *
 * `process.env` members are strings, but the `typeof` guard keeps a host that
 * has had the object replaced or patched from steering this module down an
 * unexpected path.
 *
 * @param {string} name environment variable name
 * @returns {string} trimmed value, or `''` when absent
 */
const readRaw = (name) => {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
};

/**
 * Trimmed string value, or `fallback` when the variable is absent.
 *
 * @param {string} name environment variable name
 * @param {string} fallback restrictive default
 * @returns {string}
 */
const readString = (name, fallback) => {
  const value = readRaw(name);
  return value === '' ? fallback : value;
};

/**
 * Trimmed string value, or `null` when the variable is absent.
 *
 * `null` rather than `undefined` keeps the member visible under
 * `JSON.stringify`, which is what makes inspecting the resolved
 * configuration a meaningful check.
 *
 * @param {string} name environment variable name
 * @returns {string|null}
 */
const readOptionalString = (name) => {
  const value = readRaw(name);
  return value === '' ? null : value;
};

/**
 * Integer value, or `fallback` when the variable is absent.
 *
 * The WHOLE trimmed string must be a base-10 integer. A `parseInt`-style read
 * would silently truncate `100abc` to `100` and hand the middleware a budget
 * its operator never wrote; a security budget is never guessed, so anything
 * that is not wholly an integer - and anything outside the accepted range -
 * throws at require time. `NaN` and `Infinity` are unreachable by
 * construction: neither can match INTEGER_PATTERN.
 *
 * @param {string} name environment variable name
 * @param {number} fallback restrictive default
 * @param {{minimum: number, maximum?: number, note?: string}} bounds accepted
 *        range, plus an optional note appended when the value is too small
 * @returns {number}
 * @throws {Error} when the value is present but not an in-range integer
 */
const readInteger = (name, fallback, bounds) => {
  const raw = readRaw(name);
  if (raw === '') {
    return fallback;
  }
  const maximum = typeof bounds.maximum === 'number' ? bounds.maximum : Number.MAX_SAFE_INTEGER;
  const note = typeof bounds.note === 'string' ? ' ' + bounds.note : '';
  if (!INTEGER_PATTERN.test(raw)) {
    throw new Error(
      name +
        ' must be a whole base-10 integer with no unit, suffix or decimal part;' +
        ' the value provided is not one.'
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(name + ' must be an integer inside the safe integer range; the value provided is too large.');
  }
  if (value < bounds.minimum) {
    throw new Error(
      name + ' must be an integer of at least ' + bounds.minimum + '; the value provided is smaller.' + note
    );
  }
  if (value > maximum) {
    throw new Error(name + ' must be an integer of at most ' + maximum + '; the value provided is larger.');
  }
  return value;
};

/**
 * Boolean value, or `fallback` when the variable is absent.
 *
 * Only the explicit affirmatives and the explicit negatives are accepted.
 * Anything else throws rather than being coerced: silently reading an
 * unrecognised value such as `ture` as "disabled" would serve cleartext to an
 * operator who asked for encryption, and would do so without a word.
 *
 * @param {string} name environment variable name
 * @param {boolean} fallback restrictive default
 * @returns {boolean}
 * @throws {Error} when the value is present but neither affirmative nor negative
 */
const readBoolean = (name, fallback) => {
  const raw = readRaw(name);
  if (raw === '') {
    return fallback;
  }
  const value = raw.toLowerCase();
  if (AFFIRMATIVE_VALUES.includes(value)) {
    return true;
  }
  if (NEGATIVE_VALUES.includes(value)) {
    return false;
  }
  throw new Error(
    name +
      ' must be one of true, 1, yes, on to enable, or false, 0, no, off to disable;' +
      ' the value provided is neither and is refused rather than guessed.'
  );
};

/**
 * Comma-separated list, trimmed entry by entry with empty entries dropped.
 * An absent variable yields an empty list; the caller decides what an empty
 * list means, and in every case here it means the restrictive outcome.
 *
 * @param {string} name environment variable name
 * @returns {string[]}
 */
const readList = (name) => {
  const raw = readRaw(name);
  if (raw === '') {
    return [];
  }
  const entries = [];
  for (const candidate of raw.split(',')) {
    const entry = candidate.trim();

    if (entry !== '') {
      entries.push(entry);
    }
  }
  return entries;
};

/* -------------------------------------------------------------------------
 * Per-setting resolvers for the three settings whose rules exceed a reader.
 * ---------------------------------------------------------------------- */

/**
 * Cross-origin allow-list (V-06).
 *
 * An absent or empty variable yields an EMPTY array, which the `cors` origin
 * callback reads as "deny every cross-origin caller". That is the deliberate
 * fail-closed default and it must never throw: an unconfigured deployment is
 * expected to deny, not to refuse to start.
 *
 * A wildcard, on the other hand, is an operator error that must be loud. `*`
 * would admit every origin, satisfying "configure CORS" in name while leaving
 * the finding entirely unremediated, and a pattern such as a subdomain glob
 * would never match anything because matching is by exact string - the
 * operator would see an inexplicable denial. Neither is silently stripped.
 *
 * Retained entries are lowercased and stripped of a single trailing slash:
 * browsers send `Origin` with no trailing slash, so an un-normalised entry
 * carrying one could never match. Duplicates collapse.
 *
 * Semantics for consumers: EXACT string match only. No wildcards, no
 * subdomain globbing, no regular expressions.
 *
 * @returns {string[]} normalised, de-duplicated origins; empty means deny all
 * @throws {Error} when an entry contains a wildcard
 */
const resolveAllowedOrigins = () => {
  const origins = [];
  for (const entry of readList('ALLOWED_ORIGINS')) {
    if (entry.includes(WILDCARD)) {
      throw new Error(
        'ALLOWED_ORIGINS must be a comma-separated list of exact origins and must not contain "*":' +
          ' a wildcard would admit every origin, and a wildcard pattern would never match because' +
          ' origins are compared by exact string. Enumerate each permitted origin in full, or leave' +
          ' the variable unset to deny all cross-origin callers.'
      );
    }

    const origin = entry.toLowerCase().replace(/\/$/, '');

    if (origin !== '' && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
};

/**
 * HTTP method allow-list (V-02, V-07).
 *
 * Entries are uppercased and de-duplicated, and an absent or empty variable
 * yields `['GET', 'HEAD']` - least privilege, the only verbs the service
 * implements. The list stays configurable so a legitimate verb can be
 * admitted without a code change, but the three verbs whose rejection IS a
 * control can never be admitted, and an entry that is not shaped like a
 * method token is refused so that nothing header-shaped can reach the `Allow`
 * header.
 *
 * Consumers must join this array with `', '` (comma AND space) to emit
 * `Allow`, which for the default list is exactly `Allow: GET, HEAD`. This
 * array is the single source of truth for that header.
 *
 * @returns {string[]} uppercase, de-duplicated method names
 * @throws {Error} when an entry is forbidden or is not a method token
 */
const resolveAllowedMethods = () => {
  const entries = readList('ALLOWED_METHODS');
  if (entries.length === 0) {
    return DEFAULT_ALLOWED_METHODS.slice();
  }
  const methods = [];
  for (const entry of entries) {
    const method = entry.toUpperCase();

    if (!METHOD_TOKEN_PATTERN.test(method)) {
      throw new Error(
        'ALLOWED_METHODS must be a comma-separated list of HTTP method names built from letters,' +
          ' digits and hyphens, such as GET or HEAD; one of the entries provided is not.'
      );
    }

    const forbiddenIndex = FORBIDDEN_METHODS.indexOf(method);

    if (forbiddenIndex !== -1) {
      throw new Error(
        'ALLOWED_METHODS must not include ' +
          FORBIDDEN_METHODS[forbiddenIndex] +
          ': refusing that verb is itself a control - Cross-Site Tracing for TRACE and TRACK,' +
          ' proxy abuse for CONNECT - so it cannot be admitted through configuration. Remove it' +
          ' from the list.'
      );
    }

    if (!methods.includes(method)) {
      methods.push(method);
    }
  }
  return methods;
};

/**
 * Request-body ceiling (V-02).
 *
 * The value is passed through unchanged, as a string, because that is the
 * form `express.json({ limit })` and `express.urlencoded({ limit })` accept
 * directly; a plain byte count is equally acceptable to them and is likewise
 * passed through rather than reformatted. The one ceiling resolved here is
 * applied uniformly to EVERY body parser the middleware mounts, so there is a
 * single ceiling rather than divergent per-parser limits.
 *
 * The shape check is a fail-closed requirement: the parsers interpret a size
 * they cannot parse as no limit at all, so `JSON_BODY_LIMIT=1kbb` would
 * silently restore the unbounded request body this remediation closes.
 * Nothing heavier than a shape check happens here - no size library is
 * imported, and none may be.
 *
 * @returns {string} byte-size string
 * @throws {Error} when the value is present but is not a byte size
 */
const resolveBodyLimit = () => {
  const raw = readRaw('JSON_BODY_LIMIT');
  if (raw === '') {
    return DEFAULT_JSON_BODY_LIMIT;
  }
  if (!BYTE_SIZE_PATTERN.test(raw)) {
    throw new Error(
      'JSON_BODY_LIMIT must be a byte size such as 1kb, 512b or 10kb, or a plain byte count;' +
        ' the value provided is neither. It is refused rather than passed through because a body' +
        ' parser treats a size it cannot parse as no limit at all.'
    );
  }
  return raw;
};

/* -------------------------------------------------------------------------
 * Resolution. Everything below runs exactly once, at require time, so a
 * misconfigured deployment refuses to start instead of running with a
 * silently weakened policy.
 * ---------------------------------------------------------------------- */

const host = readString('HOST', DEFAULT_HOST);

const port = readInteger('PORT', DEFAULT_PORT, {
  minimum: 0,
  maximum: MAX_PORT,
  note: 'Use 0 to let the operating system assign an ephemeral port.',
});

const allowedOrigins = resolveAllowedOrigins();

const allowedMethods = resolveAllowedMethods();

// A window of 0 has no meaning, and `express-rate-limit` treats a limit of 0
// as "no limit", so 0 is a fail-open trap rather than a valid budget. Both
// values are therefore required to be 1 or greater.
const rateLimitWindowMs = readInteger('RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, {
  minimum: 1,
  note: 'A window of 0 milliseconds would leave the limiter with nothing to account against.',
});

const rateLimitMax = readInteger('RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, {
  minimum: 1,
  note: 'A budget of 0 disables the limiter outright, which is why a positive value is required.',
});

const jsonBodyLimit = resolveBodyLimit();

// TLS is opt-in so that the service still starts with no environment
// variables and no certificate material present, which is a hard requirement.
const tlsEnabled = readBoolean('TLS_ENABLED', false);

// Filesystem PATHS only - never inline key material, never a default path
// inside the repository, never a committed value of any kind. This module
// does not read, open or stat either file: the listener reads them, so no
// private key byte ever enters this module's memory, no I/O happens at
// require time, and no time-of-check-to-time-of-use gap is created here.
// No error message below names anything beyond the variable itself.
const tlsKeyPath = readOptionalString('TLS_KEY_PATH');

const tlsCertPath = readOptionalString('TLS_CERT_PATH');

if (tlsEnabled && tlsKeyPath === null) {
  throw new Error(
    'TLS_KEY_PATH must be set to the filesystem path of the TLS private key when TLS_ENABLED is on.' +
      ' Falling back to cleartext because a path is missing would serve unencrypted traffic to a' +
      ' deployment that explicitly asked for HTTPS, so startup is refused instead.'
  );
}

if (tlsEnabled && tlsCertPath === null) {
  throw new Error(
    'TLS_CERT_PATH must be set to the filesystem path of the TLS certificate when TLS_ENABLED is on.' +
      ' Falling back to cleartext because a path is missing would serve unencrypted traffic to a' +
      ' deployment that explicitly asked for HTTPS, so startup is refused instead.'
  );
}

// Zero is legitimate here, unlike the rate-limit budgets: retracting the HSTS
// pin by setting a max-age of 0 is how a staged rollout is unwound.
const hstsMaxAge = readInteger('HSTS_MAX_AGE', DEFAULT_HSTS_MAX_AGE, {
  minimum: 0,
  note: 'Use 0 to retract a previously issued Strict-Transport-Security pin.',
});

/**
 * The resolved, deeply frozen security configuration.
 *
 * Every array and every nested object is frozen alongside the top-level
 * object, so no consumer can widen an allow-list, raise a budget or switch
 * transports at runtime. The shape is fixed and enumerated literally: there
 * is no dynamic key construction anywhere in this module.
 *
 * @type {Readonly<{
 *   host: string,
 *   port: number,
 *   cors: Readonly<{allowedOrigins: ReadonlyArray<string>}>,
 *   methods: Readonly<{allowed: ReadonlyArray<string>}>,
 *   rateLimit: Readonly<{windowMs: number, max: number}>,
 *   body: Readonly<{jsonLimit: string}>,
 *   tls: Readonly<{enabled: boolean, keyPath: string|null, certPath: string|null, minVersion: string}>,
 *   hsts: Readonly<{maxAge: number, includeSubDomains: boolean}>
 * }>}
 */
const securityConfig = Object.freeze({
  host,
  port,
  cors: Object.freeze({
    allowedOrigins: Object.freeze(allowedOrigins),
  }),
  methods: Object.freeze({
    allowed: Object.freeze(allowedMethods),
  }),
  rateLimit: Object.freeze({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
  }),
  body: Object.freeze({
    jsonLimit: jsonBodyLimit,
  }),
  tls: Object.freeze({
    enabled: tlsEnabled,
    keyPath: tlsKeyPath,
    certPath: tlsCertPath,
    minVersion: TLS_MIN_VERSION,
  }),
  hsts: Object.freeze({
    maxAge: hstsMaxAge,
    includeSubDomains: HSTS_INCLUDE_SUBDOMAINS,
  }),
});

module.exports = securityConfig;

