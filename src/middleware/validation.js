'use strict';

/**
 * Schema validation - the last stage a request passes before the route table.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The pre-remediation listener never read the request at all: not
 * `req.method`, not `req.url`, not `req.headers` and not the body. Every
 * request was therefore "valid" by construction, which is what made
 * `DELETE /../../etc/passwd` answer `200` and a 100,000-byte `PUT` body be
 * accepted with no bound whatsoever. The method allow-list, the route table
 * and the size-capped body parsers in `src/middleware/security.js` close the
 * method, path and size axes of that finding; this module closes the fourth -
 * the SHAPE of what arrives - and establishes the validation seam that any
 * future route inherits automatically.
 *
 * FINDING CLOSED: the remainder of V-02, Improper Input Validation (CWE-20)
 * with Allocation of Resources Without Limits (CWE-770). Standards applied:
 * OWASP Top 10 2021 A03 Injection, OWASP ASVS v4 V5 (Validation, Sanitization
 * and Encoding), OWASP API Security Top 10 API4 (Unrestricted Resource
 * Consumption), and CWE-209 (Information Exposure Through an Error Message)
 * for the shape of the rejection - see THE DISCLOSURE RULE below.
 *
 * PIPELINE POSITION - order matters and this stage is deliberately last
 * --------------------------------------------------------------------
 *   helmet() -> cors() -> express-rate-limit -> top-level method allow-list
 *   -> body parsers with byte ceilings -> THIS MODULE -> route table
 *   -> 404 handler -> error handler
 *
 * Running after the parsers is what lets this module inspect `req.body` at
 * all, and it means an oversized payload is already refused with `413` by the
 * parser before a schema ever sees it - cheaper, and it never materialises the
 * payload. Running before the route table means no handler can ever observe an
 * unvalidated input surface, including on paths that do not exist.
 *
 * The stage is independently disableable: commenting out its `app.use` line in
 * `src/app.js` leaves every other control working, because nothing here
 * depends on another stage's side effects and nothing else depends on this
 * one's.
 *
 * PERMISSIVE WHERE IT MUST BE, BOUNDED EVERYWHERE
 * -----------------------------------------------
 * Hardening may not break the service. The only response changes sanctioned
 * for this remediation are a rejected method (`405`), an unknown path (`404`),
 * an oversized or malformed payload (`413`/`400`), an over-budget client
 * (`429`), a denied cross-origin caller and a TLS-incapable client. Refusing
 * an ordinary request is NOT among them, so:
 *
 *   - unknown HEADER keys are allowed through. Node and every HTTP client add
 *     headers nobody enumerated (`host`, `user-agent`, `accept`,
 *     `accept-encoding`, `connection`, `keep-alive`, proxy headers), so a
 *     strict header schema would reject every real request - including the
 *     `GET /` whose 14-byte body is a hard behavioural gate.
 *   - unknown QUERY keys are allowed through. `GET /?x=1` answered `200`
 *     before this change and still does. The query schema is a bound on
 *     resource consumption, not an allow-list: it caps how many parameters
 *     arrive and how large each one may be, and rejects only abuse.
 *
 * What is NOT permissive: path parameters (the only route is the literal
 * `GET /`, so any path parameter at all is a wiring error) and the request
 * body (no method in the default allow-list carries one).
 *
 * THE DISCLOSURE RULE - the hazard here is concrete, not theoretical
 * -----------------------------------------------------------------
 * A `zod` issue echoes attacker-supplied input verbatim. An unrecognised-key
 * failure produces, literally:
 *
 *   {"code":"unrecognized_keys","keys":["a"],"path":[],
 *    "message":"Unrecognized key: \"a\""}
 *
 * Both `keys` and `message` carry the caller's own token back. Copying either
 * into a response - or into the audit log - would turn a defensive control
 * into a reflection primitive (CWE-209). Therefore, without exception:
 *
 *   - `issue.message`, `issue.keys`, `issue.received`, `issue.expected` and
 *     every received value are NEVER read by this module.
 *   - only `issue.path` and `issue.code` contribute to the sanitised summary,
 *     and both are scrubbed and length-capped here anyway, so a hostile
 *     segment could not survive even if one reached them.
 *   - the summary goes to the audit log and onto `err.validation` for
 *     diagnostics. It never reaches the client: `src/middleware/errors.js`
 *     builds the problem document from a static status -> title map and
 *     ignores `err.message`, so a rejected caller receives exactly
 *     `{"type":"about:blank","title":"Bad Request","status":400}`.
 *   - no filesystem path, module name or dependency version appears anywhere
 *     in a response or a log record produced here.
 *
 * Every bound this module enforces is breached with a STATIC issue code of
 * this module's own making (`query_entry_limit`, `body_not_permitted`, ...),
 * which is why the summary is informative without being reflective.
 *
 * MODULE CONTRACT
 * ---------------
 * CommonJS (`package.json` declares no `type` field). Exactly three imports:
 * `zod` for the schemas, `config/security.js` for policy and
 * `./logging` for the audit trail - the last of which adds no dependency,
 * since that module imports nothing itself. `process.env` is never read here;
 * every threshold is either a setting resolved by `config/security.js` at its
 * own require time or a named constant below. Nothing is re-read per request.
 *
 * The success path is inert by construction: it sets no header, writes no
 * body, never touches `res`, and calls `next()` with no argument. That is what
 * keeps `GET /` returning `200` with a body of exactly 14 bytes,
 * `Hello, World!\n`.
 *
 * `req.query` is a getter in Express 5 and `req.params`, `req.headers` and
 * `req.body` may be absent when a stage upstream is disabled, so every input
 * is read through a guarded reader and an absent surface simply has nothing to
 * validate. The parsed values are exposed on `req.validated` for convenience;
 * `req.query` and `req.headers` are NEVER assigned to, because assigning to a
 * getter throws.
 *
 * EXPORTS
 * -------
 *   module.exports                 -> validateRequest (ready to mount)
 *   module.exports.validateRequest -> the same middleware, named
 *   module.exports.validate        -> validate(schemaSet) factory
 *   module.exports.schemas         -> { params, query, headers, body }
 */

const { z } = require('zod');

const config = require('../../config/security');

const { logSecurityEvent, SECURITY_EVENTS } = require('./logging');

/* -------------------------------------------------------------------------
 * Constants. Every threshold below is a named module constant rather than an
 * environment variable: `config/security.js` owns exactly eleven variables
 * and this module may not add a twelfth. None of these bounds is a policy an
 * operator needs to tune - they exist to refuse abuse, and the values the
 * service genuinely depends on (`ALLOWED_METHODS`, `JSON_BODY_LIMIT`) are
 * configuration and live there.
 * ---------------------------------------------------------------------- */

/**
 * The four input surfaces, in evaluation order. Validation short-circuits on
 * the first surface that fails: the response is identical either way, and
 * stopping early bounds the work a hostile request can provoke.
 */
const LOCATIONS = Object.freeze(['params', 'query', 'headers', 'body']);

/** Status delegated for every violation this module detects. */
const BAD_REQUEST_STATUS = 400;

/**
 * Message on the delegated error. Static, and never serialised into a
 * response - `src/middleware/errors.js` ignores `err.message` entirely. It
 * exists so a stack captured on stderr by some other consumer is readable.
 */
const FAILURE_MESSAGE = 'Request validation failed';

/** Static message on every issue this module raises. Never echoed anywhere. */
const BOUND_MESSAGE = 'Input outside permitted bounds';

/** Methods that may legitimately carry a request body, per RFC 9110. */
const BODY_BEARING_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Query-string bounds (CWE-770, OWASP API4). The route consumes no query
 * parameter, so these are generous by design: they are two orders of
 * magnitude above anything a legitimate caller of a `GET /` service sends,
 * and their only purpose is to refuse a request built to make the parser and
 * the validator do unbounded work.
 *
 * Express 5 resolves `req.query` with its `'simple'` parser, so values are
 * strings or arrays of strings and nesting never exceeds one level; the depth
 * bound is therefore defence in depth against a future `'extended'` parser
 * rather than a live constraint.
 */
const MAX_QUERY_PARAMETERS = 32;
const MAX_QUERY_KEY_LENGTH = 64;
const MAX_QUERY_VALUE_LENGTH = 512;
const MAX_QUERY_DEPTH = 4;
const MAX_QUERY_CHARACTERS = 4096;

/**
 * Request-body bounds, applied only when the method allow-list admits a
 * body-bearing verb. They are belt and braces: the authoritative ceiling is
 * `config.body.jsonLimit` (`'1kb'` by default), enforced by the body parsers
 * before this stage runs, so a payload reaching here is already small.
 */
const MAX_BODY_ENTRIES = 64;
const MAX_BODY_KEY_LENGTH = 128;
const MAX_BODY_VALUE_LENGTH = 1024;
const MAX_BODY_DEPTH = 8;
const MAX_BODY_CHARACTERS = 8192;

/**
 * `Content-Length` bounds. The digit cap keeps `Number()` away from an
 * arbitrarily long numeric string, and the byte cap refuses a header that
 * claims a payload no `GET`/`HEAD` service could plausibly receive. Neither
 * replaces the parsers' ceiling - a body that is actually oversized is
 * refused with `413` upstream; this refuses an implausible CLAIM about one.
 */
const CONTENT_LENGTH_PATTERN = /^[0-9]{1,15}$/;
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;

/** `Content-Type` ceiling. Well above any real media type with parameters. */
const MAX_CONTENT_TYPE_LENGTH = 512;

/**
 * Static issue codes. Each names exactly which bound was breached, contains
 * no caller-supplied text, and is safe to log and to assert on in tests.
 */
const QUERY_CODES = Object.freeze({
  entries: 'query_entry_limit',
  keyLength: 'query_key_length',
  valueLength: 'query_value_length',
  depth: 'query_depth_limit',
  characters: 'query_size_limit',
  unsupported: 'query_value_unsupported',
});

const BODY_CODES = Object.freeze({
  entries: 'body_entry_limit',
  keyLength: 'body_key_length',
  valueLength: 'body_value_length',
  depth: 'body_depth_limit',
  characters: 'body_size_limit',
  unsupported: 'body_value_unsupported',
});

/** Raised when a body arrives although no permitted method carries one. */
const BODY_NOT_PERMITTED_CODE = 'body_not_permitted';

/** Raised when `Content-Length` claims more than the byte cap above. */
const CONTENT_LENGTH_CODE = 'content_length_limit';

/** Recorded when an input surface cannot be read at all (a throwing getter). */
const UNREADABLE_CODE = 'input_unreadable';

/** Bundled bounds handed to the structure walker. */
const QUERY_LIMITS = Object.freeze({
  maxEntries: MAX_QUERY_PARAMETERS,
  maxKeyLength: MAX_QUERY_KEY_LENGTH,
  maxValueLength: MAX_QUERY_VALUE_LENGTH,
  maxDepth: MAX_QUERY_DEPTH,
  maxCharacters: MAX_QUERY_CHARACTERS,
  codes: QUERY_CODES,
});

const BODY_LIMITS = Object.freeze({
  maxEntries: MAX_BODY_ENTRIES,
  maxKeyLength: MAX_BODY_KEY_LENGTH,
  maxValueLength: MAX_BODY_VALUE_LENGTH,
  maxDepth: MAX_BODY_DEPTH,
  maxCharacters: MAX_BODY_CHARACTERS,
  codes: BODY_CODES,
});

/* Sanitised-summary bounds. The summary is diagnostics, so it is small. */

/** Issues reported per failure; the rest are counted but not described. */
const MAX_REPORTED_ISSUES = 5;

/** Path segments and total field-path length kept per issue. */
const MAX_PATH_SEGMENTS = 4;
const MAX_FIELD_PATH_LENGTH = 64;

/** Ceiling on an issue code, and on the whole joined summary. */
const MAX_ISSUE_CODE_LENGTH = 32;
const MAX_SUMMARY_LENGTH = 200;

/**
 * Characters retained in a field path or an issue code. Everything else -
 * quotes, angle brackets, whitespace, carriage returns, line feeds, every
 * non-ASCII byte - is stripped, so neither a log line nor a diagnostic field
 * can be steered by a caller (CWE-117) even though nothing attacker-derived
 * is supposed to reach them in the first place.
 */
const UNSAFE_SEGMENT_CHARACTERS = /[^A-Za-z0-9_.-]/g;

/** Field path reported when an issue has no path (a whole-surface failure). */
const ROOT_FIELD = '(root)';

/** Code reported when an issue carries none that survives sanitisation. */
const FALLBACK_CODE = 'invalid';

/** Separators for the joined summary, e.g. `query:query_entry_limit`. */
const FIELD_PATH_SEPARATOR = '.';
const FIELD_CODE_SEPARATOR = ':';
const SUMMARY_SEPARATOR = ', ';

/**
 * Whether any permitted method may carry a request body, resolved ONCE at
 * require time from `config.methods.allowed` (`['GET', 'HEAD']` by default,
 * and the configuration module reads the environment at its own require
 * time). With the default allow-list nothing legitimate carries a body, so a
 * non-empty one is refused outright; if an operator admits `POST`, `PUT`,
 * `PATCH` or `DELETE` through `ALLOWED_METHODS`, a body becomes legitimate
 * and is bounded instead of refused - a configuration change must not create
 * a dead end where every admitted request is rejected.
 */
const bodyExpected = config.methods.allowed.some((method) =>
  BODY_BEARING_METHODS.includes(method)
);

/* -------------------------------------------------------------------------
 * Sanitisation helpers. Everything a failure produces passes through these,
 * so the disclosure rule is enforced in one place rather than at each call
 * site. None of them throws, whatever it is handed.
 * ---------------------------------------------------------------------- */

/**
 * Reduce one path segment to a bounded, scrubbed token.
 *
 * Segments are normally this module's own literal field names
 * (`content-length`) or array indices, but a segment is treated as untrusted
 * regardless: a schema change could introduce a caller-derived one, and this
 * is the layer that must make that harmless.
 *
 * @param {unknown} segment element of `issue.path`
 * @returns {string} scrubbed token, or `''` when the segment is unusable
 */
const sanitiseSegment = (segment) => {
  let text;
  if (typeof segment === 'string') {
    text = segment;
  } else if (typeof segment === 'number' && Number.isFinite(segment)) {
    text = String(segment);
  } else {
    // Symbols and exotic values carry no diagnostic value and are dropped.
    return '';
  }
  return text.replace(UNSAFE_SEGMENT_CHARACTERS, '').slice(0, MAX_FIELD_PATH_LENGTH);
};

/**
 * Render `issue.path` as a dotted field path. `issue.message`, `issue.keys`,
 * `issue.received` and `issue.expected` are deliberately not consulted - see
 * THE DISCLOSURE RULE in the module docblock.
 *
 * @param {unknown} path `issue.path`, normally an array of string|number
 * @returns {string} dotted path, or `ROOT_FIELD` when there is none
 */
const fieldPath = (path) => {
  if (!Array.isArray(path) || path.length === 0) {
    return ROOT_FIELD;
  }
  const segments = [];
  for (const segment of path) {
    if (segments.length >= MAX_PATH_SEGMENTS) {
      break;
    }
    const safe = sanitiseSegment(segment);
    if (safe !== '') {
      segments.push(safe);
    }
  }
  if (segments.length === 0) {
    return ROOT_FIELD;
  }
  return segments.join(FIELD_PATH_SEPARATOR).slice(0, MAX_FIELD_PATH_LENGTH);
};

/**
 * Reduce `issue.code` to a bounded, scrubbed token. Codes are either `zod`'s
 * own (`invalid_type`, `too_big`, `unrecognized_keys`, `invalid_format`) or
 * one of this module's static codes; both are safe, and both are scrubbed
 * anyway so that no future code can widen what reaches a log line.
 *
 * @param {unknown} code `issue.code`
 * @returns {string} scrubbed code, or `FALLBACK_CODE`
 */
const issueCode = (code) => {
  if (typeof code !== 'string') {
    return FALLBACK_CODE;
  }
  const scrubbed = code.replace(UNSAFE_SEGMENT_CHARACTERS, '').slice(0, MAX_ISSUE_CODE_LENGTH);
  return scrubbed === '' ? FALLBACK_CODE : scrubbed;
};

/**
 * Build the sanitised summary of a failure: at most `MAX_REPORTED_ISSUES`
 * entries of the form `field:code`, joined and length-capped.
 *
 * This is the ONLY function that reads a `zod` issue, and it reads exactly two
 * of its properties. Nested issue collections - `invalid_union` carries an
 * `errors` array whose members echo caller input - are never descended into;
 * the union itself contributes its own code and nothing more.
 *
 * @param {unknown} issues `error.issues` from a failed `safeParse`
 * @returns {string} summary, or `''` when nothing could be summarised
 */
const summariseIssues = (issues) => {
  const parts = [];
  try {
    if (Array.isArray(issues)) {
      for (const issue of issues) {
        if (parts.length >= MAX_REPORTED_ISSUES) {
          break;
        }
        const usable = issue !== null && typeof issue === 'object';
        const path = usable ? issue.path : undefined;
        const code = usable ? issue.code : undefined;
        parts.push(fieldPath(path) + FIELD_CODE_SEPARATOR + issueCode(code));
      }
    }
  } catch {
    // A throwing getter on an issue object costs the rest of the summary and
    // nothing else; the parts already collected are still emitted.
  }
  return parts.join(SUMMARY_SEPARATOR).slice(0, MAX_SUMMARY_LENGTH);
};

/**
 * Number of issues behind a failure, for the audit record. Counted rather
 * than described, so the count is safe even when the descriptions are capped.
 *
 * @param {unknown} issues `error.issues` from a failed `safeParse`
 * @returns {number} issue count, at least 1
 */
const countIssues = (issues) => {
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.length;
  }
  // A failed parse always means at least one violation, whatever the shape of
  // the reported issue list.
  return 1;
};

/* -------------------------------------------------------------------------
 * Bound checking. Both the query and the body are bounded rather than
 * whitelisted, so the work is shared by one walker driven by a limits object.
 * ---------------------------------------------------------------------- */

/**
 * True when a request carries no body worth validating.
 *
 * Every shape a parser can leave behind is accounted for: `undefined` when no
 * parser matched the content type, `{}` from `express.json`/`express.urlencoded`
 * on an empty body, `''` from a text parser and a zero-length `Buffer` from a
 * raw parser. Anything else - including a populated object, a non-empty array
 * and a bare scalar - is a payload.
 *
 * @param {unknown} value `req.body` as the parsers left it
 * @returns {boolean} whether the body is absent or empty
 */
const isEmptyBody = (value) => {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value === '';
  }
  if (typeof value !== 'object') {
    // A number, boolean, bigint, symbol or function body is a payload.
    return false;
  }
  if (Buffer.isBuffer(value)) {
    return value.length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  try {
    return Object.keys(value).length === 0;
  } catch {
    // An object whose keys cannot even be enumerated is not treated as empty.
    return false;
  }
};

/**
 * Walk a parsed structure against a set of bounds, returning the static code
 * of the first bound breached, or `null` when the structure is acceptable.
 *
 * The walk is bounded on four independent axes - entry count, key length,
 * scalar length and nesting depth - plus a shared character budget spanning
 * the whole structure, so neither breadth, depth nor total volume can be used
 * to make this stage expensive (CWE-770). It returns on the first breach, so
 * a hostile structure is abandoned rather than fully traversed, and the depth
 * cap means the recursion cannot exhaust the stack.
 *
 * @param {unknown} value node to inspect
 * @param {{maxEntries: number, maxKeyLength: number, maxValueLength: number,
 *          maxDepth: number, maxCharacters: number,
 *          codes: Object<string, string>}} limits bounds and their codes
 * @param {{characters: number}} state character budget shared across the walk
 * @param {number} depth current nesting depth, `0` at the root
 * @returns {string|null} static issue code, or `null` when within bounds
 */
const measureStructure = (value, limits, state, depth) => {
  if (depth > limits.maxDepth) {
    return limits.codes.depth;
  }

  if (typeof value === 'string') {
    if (value.length > limits.maxValueLength) {
      return limits.codes.valueLength;
    }
    state.characters += value.length;
    return state.characters > limits.maxCharacters ? limits.codes.characters : null;
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length > limits.maxEntries) {
      return limits.codes.entries;
    }
    for (const element of value) {
      const violation = measureStructure(element, limits, state, depth + 1);
      if (violation !== null) {
        return violation;
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return limits.codes.unsupported;
    }
    if (keys.length > limits.maxEntries) {
      return limits.codes.entries;
    }
    for (const key of keys) {
      if (key.length > limits.maxKeyLength) {
        return limits.codes.keyLength;
      }
      state.characters += key.length;
      if (state.characters > limits.maxCharacters) {
        return limits.codes.characters;
      }
      let member;
      try {
        member = value[key];
      } catch {
        // A throwing getter is not something a parser produces, and it is not
        // something this module is willing to traverse.
        return limits.codes.unsupported;
      }
      const violation = measureStructure(member, limits, state, depth + 1);
      if (violation !== null) {
        return violation;
      }
    }
    return null;
  }

  // Functions, symbols and bigints cannot come out of the query parser or
  // `JSON.parse`; refusing them keeps the accepted value space closed.
  return limits.codes.unsupported;
};

/**
 * Raise one bounded-structure issue on a `zod` validation context.
 *
 * @param {Object} ctx `zod` check context, carrying `value` and `issues`
 * @param {string} code static issue code
 * @returns {void}
 */
const pushIssue = (ctx, code) => {
  // No `input` member is supplied: an issue that carries the offending value
  // would put caller-supplied content inside the error object itself.
  ctx.issues.push({ code, message: BOUND_MESSAGE, path: [] });
};


/* -------------------------------------------------------------------------
 * The four schemas - one per input surface, exported so each can be
 * unit-tested directly with no HTTP involved.
 *
 * Every schema is `.optional()` (or accepts `undefined` outright) because an
 * input surface can legitimately be absent: `req.params` and `req.body` are
 * undefined when this middleware is exercised outside Express or with the
 * body parsers disabled, and an absent surface carries nothing to validate.
 * That is a deliberate consequence of each stage being independently
 * disableable - it is not a gap, because a surface that does not exist cannot
 * carry hostile input.
 * ---------------------------------------------------------------------- */

/**
 * Path parameters. The route table holds exactly one literal route, `GET /`,
 * which yields `req.params === {}`, and this middleware is mounted with
 * `app.use` at the root, which yields the same. A key here would mean a
 * parameterised route was mounted without a schema, so the object is strict:
 * `{}` and `undefined` pass, anything with a key is a `400`.
 *
 * Safe by construction - there is no path parameter for a caller to supply.
 */
const paramsSchema = z.strictObject({}).optional();

/**
 * `Content-Length` when present: a plain digit string, bounded in digits by
 * the pattern and in magnitude by the byte cap.
 *
 * `Number()` is only consulted for its magnitude, and only for a value that
 * already matched the pattern; a value that failed the pattern yields `NaN`,
 * which fails the comparison and so adds no second issue for the same input.
 */
const contentLengthSchema = z
  .string()
  .regex(CONTENT_LENGTH_PATTERN)
  .check((ctx) => {
    if (typeof ctx.value !== 'string') {
      return;
    }
    if (Number(ctx.value) > MAX_CONTENT_LENGTH_BYTES) {
      pushIssue(ctx, CONTENT_LENGTH_CODE);
    }
  });

/**
 * Request headers - PERMISSIVE about unknown keys, and that is the whole
 * point. `z.looseObject` passes every key it was not told about straight
 * through, so `host`, `user-agent`, `accept`, `accept-encoding`, `connection`,
 * `keep-alive` and any proxy header arrive untouched. A strict schema here
 * would reject every real request, `GET /` included, and take the service
 * down in the name of hardening.
 *
 * Exactly two headers are constrained, and only for shape: `Content-Length`
 * must be a plausible byte count, and `Content-Type` must be a string of
 * sane length. Node collapses duplicates of both to a single string, so
 * neither can arrive as an array.
 */
const headersSchema = z
  .looseObject({
    'content-length': contentLengthSchema.optional(),
    'content-type': z.string().max(MAX_CONTENT_TYPE_LENGTH).optional(),
  })
  .optional();

/**
 * Query string - BOUNDED, not whitelisted.
 *
 * Unknown keys are accepted deliberately: the route consumes no query
 * parameter, `GET /?x=1` answered `200` before this change, and rejecting
 * unknown keys is not one of the response changes this remediation sanctions.
 * (It is also why `hpp` was declined - parameter pollution is unreachable on
 * a route that reads no parameter.) What IS refused is abuse: more parameters
 * than `MAX_QUERY_PARAMETERS`, a key longer than `MAX_QUERY_KEY_LENGTH`, a
 * value longer than `MAX_QUERY_VALUE_LENGTH`, nesting deeper than
 * `MAX_QUERY_DEPTH`, an array with more than `MAX_QUERY_PARAMETERS` elements,
 * or more than `MAX_QUERY_CHARACTERS` in total - each with its own static
 * code. That makes the schema a resource bound (CWE-770, OWASP API4) rather
 * than an allow-list.
 */
const querySchema = z
  .record(z.string(), z.unknown())
  .check((ctx) => {
    const value = ctx.value;
    if (value === null || typeof value !== 'object') {
      // The record schema has already reported the wrong type; adding a bound
      // violation for the same input would double-count it.
      return;
    }
    const violation = measureStructure(value, QUERY_LIMITS, { characters: 0 }, 0);
    if (violation !== null) {
      pushIssue(ctx, violation);
    }
  })
  .optional();

/**
 * Request body.
 *
 * With the default allow-list (`GET, HEAD`) no permitted request carries a
 * body, so an absent or empty one passes - `undefined`, `{}`, `''` and a
 * zero-length `Buffer` all count as empty - and a populated body is refused
 * with `body_not_permitted`. That is squarely within the sanctioned change
 * "oversized or malformed payloads change from `200` to `413` or `400`".
 *
 * If an operator admits a body-bearing verb through `ALLOWED_METHODS`, a body
 * becomes legitimate and is bounded instead of refused, using the same walker
 * as the query. Refusing it in that case would make the configuration option
 * a dead end, and silently accepting it unbounded would reopen CWE-770.
 */
const bodySchema = z.unknown().check((ctx) => {
  if (isEmptyBody(ctx.value)) {
    return;
  }
  if (!bodyExpected) {
    pushIssue(ctx, BODY_NOT_PERMITTED_CODE);
    return;
  }
  const violation = measureStructure(ctx.value, BODY_LIMITS, { characters: 0 }, 0);
  if (violation !== null) {
    pushIssue(ctx, violation);
  }
});

/**
 * The declarative schema set, one entry per input surface. Frozen so a
 * consumer cannot swap a schema out at runtime, and exported so the schemas
 * can be asserted on directly.
 *
 * @type {Readonly<{params: Object, query: Object, headers: Object, body: Object}>}
 */
const schemas = Object.freeze({
  params: paramsSchema,
  query: querySchema,
  headers: headersSchema,
  body: bodySchema,
});

/* -------------------------------------------------------------------------
 * The adapter middleware.
 * ---------------------------------------------------------------------- */

/**
 * Per-surface readers. `req.query` is a lazily evaluated getter in Express 5
 * and `req.params`/`req.body` depend on upstream stages, so each surface is
 * reached through exactly one function and every read is guarded.
 *
 * @type {Readonly<Object<string, function(Object): unknown>>}
 */
const INPUT_READERS = Object.freeze({
  params: (req) => req.params,
  query: (req) => req.query,
  headers: (req) => req.headers,
  body: (req) => req.body,
});

/**
 * Read one input surface without ever throwing.
 *
 * A getter that throws - a malformed query a parser refuses to resolve, for
 * instance - is itself a validation failure, not a `500`: the request is
 * unusable, and answering `400` keeps the rejection inside the one
 * serialisation path.
 *
 * @param {Object} req request
 * @param {string} location one of `LOCATIONS`
 * @returns {{ok: boolean, value: unknown}} the value, or `ok: false`
 */
const readInput = (req, location) => {
  try {
    return { ok: true, value: INPUT_READERS[location](req) };
  } catch {
    return { ok: false, value: undefined };
  }
};

/**
 * Read a scalar request field for the audit record without ever throwing.
 * `req.ip` consults the `trust proxy` setting and is therefore a getter too.
 *
 * @param {Object} req request
 * @param {string} field property name
 * @returns {string|undefined} the value when it is a non-empty string
 */
const readRequestField = (req, field) => {
  try {
    const value = req[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Build the audit-record details for a failure.
 *
 * Only sanitised, primitive fields are passed: the input location, the issue
 * count and the scrubbed `field:code` summary, plus the client address and
 * method, which are what make probing detectable. `src/middleware/logging.js`
 * keeps flat primitives only and sanitises every value again, so nothing
 * structured or credential-bearing can reach the log through here - and no
 * caller-supplied value is offered to it in the first place.
 *
 * @param {Object} req request
 * @param {string} location one of `LOCATIONS`
 * @param {string} summary sanitised `field:code` summary
 * @param {number} issueCount number of violations behind the failure
 * @returns {Object<string, string|number>} flat detail fields
 */
const buildEventDetails = (req, location, summary, issueCount) => {
  const details = { location, issues: issueCount };
  const ip = readRequestField(req, 'ip');
  if (ip !== undefined) {
    details.ip = ip;
  }
  const method = readRequestField(req, 'method');
  if (method !== undefined) {
    details.method = method;
  }
  if (summary !== '') {
    details.fields = summary;
  }
  return details;
};

/**
 * Record the security event and construct the `400` to delegate.
 *
 * The audit call is fire-and-forget by contract: `logSecurityEvent` returns
 * `undefined` and never throws, and nothing on this path reads its result.
 *
 * The error carries only a status, a static message, `expose: false` and the
 * sanitised summary on `err.validation`. `src/middleware/errors.js` reads the
 * status and nothing else, so the client sees exactly
 * `{"type":"about:blank","title":"Bad Request","status":400}`; `expose` is set
 * as defence in depth for the case where that handler is unmounted and
 * Express's own final handler decides whether to reveal a message.
 *
 * @param {Object} req request
 * @param {string} location one of `LOCATIONS`
 * @param {string} summary sanitised `field:code` summary
 * @param {number} issueCount number of violations behind the failure
 * @returns {Error} error with `status` 400
 */
const rejection = (req, location, summary, issueCount) => {
  logSecurityEvent(
    SECURITY_EVENTS.VALIDATION_FAILED,
    buildEventDetails(req, location, summary, issueCount)
  );

  const err = new Error(FAILURE_MESSAGE);
  err.status = BAD_REQUEST_STATUS;
  err.expose = false;
  err.validation = Object.freeze({ location, fields: summary, issues: issueCount });
  return err;
};

/**
 * Expose the parsed values on `req.validated`.
 *
 * `req.query` and `req.headers` are NEVER assigned to: both are getters in
 * Express 5 and assigning to one throws. A fresh property is used instead,
 * and nothing in the pipeline depends on it - it exists so a future route can
 * consume parsed input without re-parsing it.
 *
 * The parsed value is a projection rather than a copy: `zod` rebuilds each
 * object, so an own `__proto__` key in the incoming query or body is dropped
 * instead of being carried forward (verified - parsing such a query leaves
 * `Object.prototype` untouched and produces no own `__proto__` member). That
 * is why a consumer should prefer `req.validated` over the raw surface, and
 * another reason nothing may treat the two as interchangeable.
 *
 * @param {Object} req request
 * @param {Object} validated parsed value per validated surface
 * @returns {void}
 */
const attachValidated = (req, validated) => {
  if (req === null || typeof req !== 'object') {
    return;
  }
  try {
    req.validated = Object.freeze(validated);
  } catch {
    // A frozen or exotic request object is not worth failing a valid request
    // over: the property is a convenience and has no dependants.
  }
};

/**
 * Build a validation middleware from a schema set.
 *
 * The schema set is checked HERE, at construction time, so a wiring mistake
 * surfaces when the application is assembled rather than on a request. Keys
 * must be drawn from `params`, `query`, `headers` and `body`; values must
 * expose `safeParse`. Surfaces are evaluated in `LOCATIONS` order, and the
 * first failure short-circuits.
 *
 * `safeParse` is used rather than `parse` deliberately: `parse` throws a
 * `ZodError` whose `issues` echo caller input, and letting one escape into the
 * generic error path would risk exactly the disclosure this module prevents.
 *
 * @param {Object<string, Object>} schemaSet schemas keyed by input location
 * @returns {function(Object, Object, Function): void} Express middleware
 * @throws {TypeError} when the schema set is not a usable set of schemas
 */
const validate = (schemaSet) => {
  if (schemaSet === null || typeof schemaSet !== 'object' || Array.isArray(schemaSet)) {
    throw new TypeError(
      'validate(schemaSet) requires an object keyed by input location, one or more of: ' +
        LOCATIONS.join(', ') +
        '.'
    );
  }

  for (const key of Object.keys(schemaSet)) {
    if (!LOCATIONS.includes(key)) {
      throw new TypeError(
        'validate(schemaSet) received an unsupported input location; the supported locations are: ' +
          LOCATIONS.join(', ') +
          '.'
      );
    }
  }

  const entries = [];
  for (const location of LOCATIONS) {
    if (!Object.hasOwn(schemaSet, location)) {
      continue;
    }
    const schema = schemaSet[location];
    if (schema === null || typeof schema !== 'object' || typeof schema.safeParse !== 'function') {
      throw new TypeError(
        'validate(schemaSet) requires every schema to expose safeParse; the entry for ' +
          location +
          ' does not.'
      );
    }
    entries.push({ location, schema });
  }

  if (entries.length === 0) {
    throw new TypeError(
      'validate(schemaSet) requires at least one schema; an empty set would validate nothing.'
    );
  }

  /**
   * Validate one request.
   *
   * The success path is inert: no header is set, no status is written, `res`
   * is never touched, and `next()` is called with no argument - which is what
   * keeps `GET /` returning its exact 14-byte body.
   *
   * @param {Object} req request
   * @param {Object} res response (never written to; present for the signature)
   * @param {Function} next Express continuation
   * @returns {void}
   * @throws {Error} the `400` when called without a continuation
   */
  return (req, res, next) => {
    const validated = {};

    for (const entry of entries) {
      const input = readInput(req, entry.location);

      if (!input.ok) {
        const unreadable = rejection(
          req,
          entry.location,
          ROOT_FIELD + FIELD_CODE_SEPARATOR + UNREADABLE_CODE,
          1
        );
        if (typeof next === 'function') {
          next(unreadable);
          return;
        }
        throw unreadable;
      }

      const result = entry.schema.safeParse(input.value);

      if (!result.success) {
        const error = result.error;
        const issues = error !== null && typeof error === 'object' ? error.issues : undefined;
        const failure = rejection(
          req,
          entry.location,
          summariseIssues(issues),
          countIssues(issues)
        );
        if (typeof next === 'function') {
          next(failure);
          return;
        }
        // Called outside Express: throwing keeps the rejection observable
        // rather than letting an invalid request continue silently.
        throw failure;
      }

      validated[entry.location] = result.data;
    }

    attachValidated(req, validated);

    if (typeof next === 'function') {
      next();
    }
  };
};

/**
 * The ready-to-mount middleware, built from all four schemas. `src/app.js`
 * mounts this immediately after the body parsers and before the route table.
 *
 * @type {function(Object, Object, Function): void}
 */
const validateRequest = validate(schemas);

/**
 * Default export is the middleware itself, so `app.use(require('./middleware/validation'))`
 * works; the named members support the explicit form and direct schema tests.
 */
module.exports = validateRequest;
module.exports.validateRequest = validateRequest;
module.exports.validate = validate;
module.exports.schemas = schemas;

