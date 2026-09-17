'use strict';

/**
 * V-03 regression suite - per-client rate limiting.
 *
 * WEAKNESSES CLOSED
 * -----------------
 *   CWE-770  Allocation of Resources Without Limits or Throttling
 *   CWE-400  Uncontrolled Resource Consumption
 *   CWE-307  Improper Restriction of Excessive Authentication Attempts
 *
 * Governing standards: OWASP API Security Top 10 API4 (Unrestricted Resource
 * Consumption) for the control itself, the IETF RateLimit header fields
 * draft-8 for how the budget is advertised, RFC 9457 Problem Details for the
 * shape of the rejection, and OWASP ASVS v4 V14 (Configuration) for the first
 * test below, which proves the limiter uses the CONFIGURED budget rather than
 * a default nobody verified.
 *
 * THE PRE-FIX STATE THIS SUITE EXISTS TO PREVENT RETURNING
 * -------------------------------------------------------
 * The 14-line listener this service replaced tracked no per-client state
 * anywhere in the process - no counter, no window, no key extraction - so
 * there was no basis on which any request could ever be refused. Probing it
 * confirmed the consequence exactly: 300 sequential `GET /` requests returned
 * 300 x `200` and ZERO `429`. A single unauthenticated client could consume
 * the service without bound.
 *
 * This file also carries half of the V-08 assertion (CWE-778, Insufficient
 * Logging): that an over-budget rejection emits a structured, machine-parsable
 * security-event record. Without it, rate-limit abuse is invisible - the
 * control would work while nobody could tell it had fired.
 *
 * !! LOAD ORDER IS LOAD-BEARING - READ BEFORE EDITING !!
 * -----------------------------------------------------
 * `config/security.js` reads `process.env` ONCE and freezes its export;
 * `server.js` requires it at load; `src/middleware/security.js` constructs the
 * limiter from it at load. The two `process.env` assignments below therefore
 * MUST stay at module scope, textually BEFORE `require('../../server.js')`.
 * Moving them into a `before()` hook would leave the production default of 100
 * requests per 15 minutes in force, this suite would never observe a `429`,
 * and it would fail for a reason that has nothing to do with the limiter. The
 * first test converts that silent trap into a loud one.
 *
 * !! THIS IS THE ONLY SUITE THAT INSTALLS A SMALL BUDGET !!
 * --------------------------------------------------------
 * `headers`, `cors`, `input-validation` and `behavior-preservation` all raise
 * `RATE_LIMIT_MAX` to a large value so the limiter never interferes with the
 * control they test. DO NOT "fix" a failure here by raising the budget: a
 * small budget is the entire point of this file. Each test file runs in its
 * own child process under `node --test`, which is precisely why a small budget
 * here cannot affect the other five suites.
 *
 * The thresholds are platform-chosen, not user-specified: no traffic volume,
 * client count or SLA was ever supplied, so the production defaults mirror the
 * library's own documented example. That is why this suite overrides them
 * instead of asserting the production numbers as though they were
 * requirements. What must be proven is that *a* budget is enforced and
 * advertised - not that a particular number is correct.
 *
 * ONE STORE, ONE KEY, ONE ORDERED SEQUENCE
 * ----------------------------------------
 * The limiter uses the library's default in-memory store and its default key
 * generator (the client address), and every `supertest(app)` request connects
 * from loopback, so every request in this file shares ONE limiter key and the
 * counts accumulate exactly as intended. Do not introduce per-request agents
 * or proxy headers: they would fragment the key and silently defeat the
 * accounting. `node --test` runs the tests in a file sequentially, so this
 * file is a single accounting sequence - the within-budget test must run
 * first, and every test after it operates on an exhausted budget.
 *
 * The window is 60 seconds and the whole file completes in milliseconds, so
 * the budget cannot silently replenish mid-run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const request = require('supertest');

/* -------------------------------------------------------------------------
 * Budget override - MUST precede the `server.js` require. See the load-order
 * warning above. Five requests per 60 seconds mirrors the configuration the
 * remediation prototype was verified against, where eight consecutive
 * requests produced `200 429 429 429 429 429 429 429` with `Retry-After: 60`
 * on every rejection. The window is long enough that it cannot expire
 * mid-test and short enough to remain a sane `Retry-After` value.
 * ---------------------------------------------------------------------- */
process.env.RATE_LIMIT_MAX = '5';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

const { app } = require('../../server.js');
const cfg = require('../../config/security.js');

/* -------------------------------------------------------------------------
 * Expected values, all derived from configuration rather than hard-coded, so
 * this suite proves the CONFIGURED budget is the enforced budget.
 * ---------------------------------------------------------------------- */

/** Requests permitted per window per client. */
const LIMIT = cfg.rateLimit.max;

/** Accounting window in milliseconds. */
const WINDOW_MS = cfg.rateLimit.windowMs;

/**
 * The window expressed in whole seconds, which is the unit both `Retry-After`
 * and the draft-8 `w=` policy parameter use.
 */
const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);

/** The preserved response body. Exactly 14 bytes; the contract under test. */
const GREETING_BODY = 'Hello, World!\n';

/** Byte length of that body, asserted rather than assumed. */
const GREETING_BYTES = 14;

/** Status the limiter returns once the budget is exhausted. */
const TOO_MANY_REQUESTS = 429;

/** Media type registered by RFC 9457 for problem detail documents. */
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/**
 * The pre-standard header set. `legacyHeaders: false` is configured, so all
 * three must be ABSENT; their reappearance is a regression to the pre-draft
 * header mode and is asserted against explicitly.
 */
const LEGACY_RATE_LIMIT_HEADERS = Object.freeze([
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
]);

/**
 * The security-event discriminator and event name emitted by
 * `src/middleware/logging.js` for an over-budget rejection. Read from that
 * module rather than guessed, so a rename there fails this assertion instead
 * of passing vacuously.
 */
const SECURITY_RECORD_KIND = 'security';
const RATE_LIMIT_EVENT = 'security.rate_limit_exceeded';

/* -------------------------------------------------------------------------
 * Inline helpers. `test/security/` holds exactly six files and no shared
 * helper module, so every utility this suite needs lives here.
 * ---------------------------------------------------------------------- */

/**
 * Issue one sequential `GET /` through the in-process application.
 *
 * `supertest(app)` binds an ephemeral port for the duration of the request,
 * so no fixed port is ever occupied and this suite cannot collide with a
 * running service or with a sibling suite. Every call is awaited
 * individually: parallel requests would make the boundary between the last
 * success and the first rejection non-deterministic.
 *
 * @returns {Promise<Object>} The supertest response.
 */
const getRoot = () => request(app).get('/');

/**
 * Read one named parameter out of a structured-field header value such as
 * `"5-in-1min"; q=5; w=60; pk=:MTJjYTE3YjQ5YWYy:`.
 *
 * Parameters are located by splitting on `;` and matching a whole trimmed
 * segment, never by scanning the full string. That matters for two reasons:
 * the draft-8 serialisation carries a partition key (`pk=`) whose opaque
 * value must never be pinned or accidentally matched into, and parsing a
 * named parameter keeps the assertion alive across a library formatting
 * change while still proving the advertised numbers are real.
 *
 * @param {string} headerValue Raw header value.
 * @param {string} name Parameter name, for example `q` or `w`.
 * @returns {string|undefined} The raw parameter value, or `undefined`.
 */
const structuredFieldParameter = (headerValue, name) => {
  if (typeof headerValue !== 'string') {
    return undefined;
  }

  const prefix = `${name}=`;

  for (const rawSegment of headerValue.split(';')) {
    const segment = rawSegment.trim();
    if (segment.startsWith(prefix)) {
      return segment.slice(prefix.length).trim();
    }
  }

  return undefined;
};

/**
 * Parse a header value that must be a non-negative base-10 integer.
 *
 * Returns `Number.NaN` for anything else - an empty value, a float, a signed
 * value or a token - so a malformed advertisement fails the assertion instead
 * of being coerced into something plausible.
 *
 * @param {string|undefined} raw Raw header or parameter value.
 * @returns {number} The parsed integer, or `Number.NaN`.
 */
const parseIntegerField = (raw) => {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw.trim())) {
    return Number.NaN;
  }
  return Number.parseInt(raw.trim(), 10);
};

/**
 * The response body as raw text, whatever the media type.
 *
 * `superagent` parses `application/problem+json` into `res.body` because its
 * JSON matcher accepts the `+json` structured suffix, but the disclosure scan
 * must run over the bytes that actually crossed the wire rather than over a
 * re-serialised object. `res.text` is used when present, with the parsed body
 * as a fallback so the scan can never silently examine an empty string.
 *
 * @param {Object} res Supertest response.
 * @returns {string} The response payload as text.
 */
const responseText = (res) => {
  if (typeof res.text === 'string' && res.text.length > 0) {
    return res.text;
  }
  if (Buffer.isBuffer(res.body)) {
    return res.body.toString('utf8');
  }
  if (res.body !== null && res.body !== undefined) {
    try {
      return JSON.stringify(res.body);
    } catch {
      return String(res.body);
    }
  }
  return '';
};

/**
 * The RFC 9457 problem document carried by a rejection.
 *
 * Parsed from `res.text` when available so the assertion is made against the
 * transmitted document; `res.body` is accepted only as a fallback.
 *
 * @param {Object} res Supertest response.
 * @returns {Object} The parsed problem document.
 */
const problemDocument = (res) => {
  const text = responseText(res);
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Fall back to the parsed body only when the raw text was unusable, so a
    // malformed document is still reported rather than silently replaced.
    if (res.body !== null && typeof res.body === 'object' && !Buffer.isBuffer(res.body)) {
      return res.body;
    }
    throw new Error(`the rejection body is not parsable JSON: ${JSON.stringify(text)}`, {
      cause: error,
    });
  }

  assert.equal(typeof parsed, 'object', 'the problem document must be a JSON object');
  assert.notEqual(parsed, null, 'the problem document must not be null');
  return parsed;
};

/**
 * Run `action` with every stdout channel observed, and return the lines it
 * emitted alongside the action's own result.
 *
 * BOTH channels are wrapped. `src/middleware/logging.js` has zero
 * dependencies and uses the runtime's own JSON serialisation, writing through
 * `console.log`; `console.log` in turn resolves `process.stdout.write` at call
 * time. Wrapping only one channel would leave this assertion able to pass
 * vacuously if the implementation ever switched to the other, so `console.log`,
 * `console.warn`, `console.error` and `process.stdout.write` are all observed.
 * A record seen on two channels simply appears twice, which is harmless
 * because the assertions search across all captured lines.
 *
 * Every stub FORWARDS to the original, deliberately: under `node --test` this
 * file runs in a child process that reports its results over stdout, so
 * swallowing writes would corrupt the runner's own reporting. The originals
 * are restored in a `finally`, because a leaked stub would corrupt it just as
 * effectively.
 *
 * @param {Function} action Async function to run while capturing.
 * @returns {Promise<{result: *, lines: string[]}>} The action's result and
 *   every non-empty line written while it ran.
 */
const captureStdout = async (action) => {
  const lines = [];

  const collect = (chunk) => {
    let text;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString('utf8');
    } else {
      return;
    }
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        lines.push(line);
      }
    }
  };

  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  // A regular function is required here: `this` must be the stream so the
  // forwarded write keeps its original receiver.
  process.stdout.write = function captureWrite(...args) {
    collect(args[0]);
    return originalWrite.apply(this, args);
  };
  console.log = (...args) => {
    collect(args.map(String).join(' '));
    originalLog(...args);
  };
  console.warn = (...args) => {
    collect(args.map(String).join(' '));
    originalWarn(...args);
  };
  console.error = (...args) => {
    collect(args.map(String).join(' '));
    originalError(...args);
  };

  try {
    const result = await action();
    return { result, lines };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
};

/**
 * Every captured line that parses as a JSON object, in capture order.
 *
 * Lines that are not JSON are skipped rather than failing the scan: the
 * forwarded test-runner protocol chunks share the same stream, and a record
 * has to be FOUND among the output rather than be the only thing in it.
 *
 * @param {string[]} lines Captured lines.
 * @returns {Object[]} The parsed JSON objects.
 */
const jsonRecords = (lines) => {
  const records = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Not a log record; ignore it.
    }
  }

  return records;
};

/* =========================================================================
 * The suite. Ordered by necessity, not by preference: there is one limiter
 * store and one client key, so the within-budget test must run before every
 * test that depends on an exhausted budget.
 * ====================================================================== */

/**
 * OWASP ASVS v4 V14 (Configuration).
 *
 * This runs FIRST and asserts nothing about HTTP at all. Its only job is to
 * prove that the module-scope override reached the frozen configuration the
 * limiter was built from. If the two `process.env` assignments were ever
 * moved into a hook, the production budget of 100 requests per 15 minutes
 * would apply, no request in this file would ever be refused, and every
 * assertion below would fail with a misleading message about the limiter. A
 * failure here says exactly what went wrong instead.
 *
 * Asserting the configured values also means every expectation in this file
 * is derived from configuration rather than hard-coded, which is what proves
 * the CONFIGURED budget is the ENFORCED budget rather than a default nobody
 * checked.
 */
test('the configured rate-limit budget is the one in force', () => {
  assert.equal(
    cfg.rateLimit.max,
    5,
    'RATE_LIMIT_MAX did not reach the frozen configuration: the environment' +
      ' assignments must stay at module scope, textually before' +
      " require('../../server.js')"
  );
  assert.equal(
    cfg.rateLimit.windowMs,
    60000,
    'RATE_LIMIT_WINDOW_MS did not reach the frozen configuration: the' +
      ' environment assignments must stay at module scope, textually before' +
      " require('../../server.js')"
  );

  // Sanity: the derivations the rest of the file relies on.
  assert.equal(LIMIT, 5);
  assert.equal(WINDOW_SECONDS, 60);
});

/**
 * Within budget, nothing changes.
 *
 * A rate limiter that refused traffic below its own budget would be a denial
 * of service rather than a control, so the permitted requests are asserted to
 * succeed AND to carry the preserved 14-byte body: throttling must not
 * perturb the response contract.
 *
 * The draft-8 `RateLimit` header is asserted on the SUCCESSFUL responses too.
 * That is the point of the standards-track header mode - a well-behaved
 * client paces itself from the advertised quota instead of discovering the
 * ceiling by being refused.
 *
 * This test consumes the entire budget for the window. Every test after it
 * therefore operates on an exhausted budget, by design.
 */
test('requests within the budget all succeed and advertise the quota', async () => {
  for (let issued = 1; issued <= LIMIT; issued += 1) {
    const res = await getRoot();

    assert.equal(
      res.status,
      200,
      `request ${issued} of ${LIMIT} is within budget and must not be refused`
    );

    // Behaviour preservation, cross-checked on the throttled path's happy
    // side. The exhaustive contract test lives in
    // behavior-preservation.test.js; this guards against a limiter that
    // rewrites or truncates a permitted response.
    assert.equal(res.text, GREETING_BODY);
    assert.equal(Buffer.byteLength(res.text, 'utf8'), GREETING_BYTES);

    assert.equal(
      typeof res.headers.ratelimit,
      'string',
      'draft-8 advertises remaining quota on success, not only on rejection'
    );
    assert.equal(typeof res.headers['ratelimit-policy'], 'string');
  }
});

/**
 * THE CORE CONTROL: the first over-budget request is refused.
 *
 * This is the assertion that the pre-fix listener could not have passed under
 * any configuration - it had no per-client state at all, so 300 sequential
 * requests produced 300 x `200`.
 *
 * `Retry-After` is asserted as a positive integer number of seconds bounded
 * by the configured window. `Retry-After: 0` would tell a client to retry
 * immediately and would make the advertisement useless, and a value above the
 * window would be advertising a wait the limiter does not actually impose.
 * The value is not pinned to a literal, because it is derived from the
 * remaining window at the moment of rejection.
 *
 * The rejection is then asserted to be STABLE: a limiter that refused once
 * and then let the next request through would leave the budget effectively
 * unbounded.
 */
test('the first over-budget request is refused with 429 and Retry-After', async () => {
  const firstRejection = await getRoot();

  assert.equal(
    firstRejection.status,
    TOO_MANY_REQUESTS,
    `request ${LIMIT + 1} exceeds the budget of ${LIMIT} and must be refused` +
      ' with 429 (the library default status, deliberately not overridden)'
  );

  const retryAfter = parseIntegerField(firstRejection.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter),
    `Retry-After must be a whole number of seconds, received ${JSON.stringify(
      firstRejection.headers['retry-after']
    )}`
  );
  assert.ok(retryAfter >= 1, 'Retry-After: 0 would tell the client to retry immediately');
  assert.ok(
    retryAfter <= WINDOW_SECONDS,
    `Retry-After (${retryAfter}s) must not exceed the configured window (${WINDOW_SECONDS}s)`
  );

  // A rejection that does not persist for the rest of the window is not a
  // budget.
  const secondRejection = await getRoot();
  assert.equal(
    secondRejection.status,
    TOO_MANY_REQUESTS,
    'the rejection must persist for the remainder of the window'
  );
});

/**
 * The IETF RateLimit header fields, draft-8.
 *
 * The budget has to be ADVERTISED, not merely enforced, so a client can pace
 * itself rather than probe for the ceiling. Both standards-track headers are
 * asserted present, and the policy header's quota and window parameters are
 * parsed and checked against the configuration - which is what proves the
 * advertised numbers are the real ones rather than a plausible-looking
 * constant.
 *
 * The exact header string is deliberately NOT pinned: the draft-8
 * serialisation carries an opaque partition key (`pk=`) whose value must not
 * become part of any assertion.
 *
 * The absence of the pre-standard `X-RateLimit-*` trio is asserted just as
 * firmly. `legacyHeaders: false` is configured, and their reappearance would
 * be a silent regression to the pre-draft header mode.
 */
test('the 429 advertises the budget through the draft-8 RateLimit headers', async () => {
  const res = await getRoot();
  assert.equal(res.status, TOO_MANY_REQUESTS, 'the budget is expected to be exhausted here');

  assert.equal(
    typeof res.headers.ratelimit,
    'string',
    'the draft-8 RateLimit header must accompany a rejection'
  );
  assert.ok(res.headers.ratelimit.length > 0);

  const policy = res.headers['ratelimit-policy'];
  assert.equal(typeof policy, 'string', 'the draft-8 RateLimit-Policy header must be present');

  const quota = parseIntegerField(structuredFieldParameter(policy, 'q'));
  assert.equal(
    quota,
    LIMIT,
    `RateLimit-Policy must advertise the configured quota (q=${LIMIT}), received ${JSON.stringify(
      policy
    )}`
  );

  const advertisedWindow = parseIntegerField(structuredFieldParameter(policy, 'w'));
  assert.equal(
    advertisedWindow,
    WINDOW_SECONDS,
    `RateLimit-Policy must advertise the configured window (w=${WINDOW_SECONDS}), received ` +
      JSON.stringify(policy)
  );

  for (const legacyHeader of LEGACY_RATE_LIMIT_HEADERS) {
    assert.equal(
      res.headers[legacyHeader],
      undefined,
      `${legacyHeader} must be absent: legacyHeaders is false, and its return would be a` +
        ' regression to the pre-standard header mode'
    );
  }
});

/**
 * Ordering Rule 1: `helmet` is mounted FIRST.
 *
 * It is mounted first precisely so that the defensive headers reach `404`,
 * `405`, `413`, `429` and `500` responses and not only successful ones -
 * error responses are exactly what an attacker probes most, so a bare
 * rejection would be a real gap. Mounting the header stage next to the route
 * handler instead would decorate the success path alone and leave this
 * throttled path undefended.
 *
 * The exhaustive twelve-header check belongs to headers.test.js. This is the
 * cross-check that the ordering actually holds on the rejection path, using a
 * representative subset. `X-Powered-By` is asserted absent here too, because
 * a rejection is a perfectly good place to fingerprint a stack.
 */
test('the 429 still carries the security headers', async () => {
  const res = await getRoot();
  assert.equal(res.status, TOO_MANY_REQUESTS, 'the budget is expected to be exhausted here');

  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');

  assert.equal(
    res.headers['x-powered-by'],
    undefined,
    'X-Powered-By must not be disclosed on a rejection either'
  );
});

/**
 * V-08 (CWE-778, Insufficient Logging) - the rate-limit rejection is audited.
 *
 * Without this record, rate-limit abuse is invisible: the control fires and
 * nobody can tell. Saturation, origin probing and method probing are exactly
 * the activities an audit trail exists to surface, so the record is part of
 * the control rather than a diagnostic convenience.
 *
 * The event is emitted by the limiter's handler on EVERY over-budget request,
 * so capturing around any rejection proves it; the first rejection itself is
 * exercised above. The capture wraps both stdout channels and restores them in
 * a `finally` - see `captureStdout`.
 *
 * The discriminator and field names asserted here were read from
 * `src/middleware/logging.js`, so a rename there fails this test rather than
 * letting it pass against nothing.
 */
test('an over-budget rejection emits a structured security-event record', async () => {
  // Snapshots taken before the capture, so the restoration can be asserted by
  // identity rather than by a function name that is an implementation detail
  // of whichever stream stdout happens to be.
  const writeBeforeCapture = process.stdout.write;
  const logBeforeCapture = console.log;
  const warnBeforeCapture = console.warn;
  const errorBeforeCapture = console.error;

  const { result: res, lines } = await captureStdout(() => getRoot());

  assert.equal(
    res.status,
    TOO_MANY_REQUESTS,
    'the capture must surround a genuine rejection'
  );

  const records = jsonRecords(lines);
  assert.ok(
    records.length > 0,
    'no single-line JSON record was written while the rejection was served'
  );

  // Search across ALL captured lines: a request record and a security-event
  // record are both emitted for this request, and the runner's own output
  // shares the stream.
  const securityRecords = records.filter(
    (record) => record.kind === SECURITY_RECORD_KIND && record.event === RATE_LIMIT_EVENT
  );

  assert.ok(
    securityRecords.length > 0,
    `no ${SECURITY_RECORD_KIND} record carrying event "${RATE_LIMIT_EVENT}" was emitted;` +
      ` captured records were ${JSON.stringify(
        records.map((record) => ({ kind: record.kind, event: record.event }))
      )}`
  );

  const securityRecord = securityRecords[0];
  assert.equal(securityRecord.level, 'warn');
  assert.equal(typeof securityRecord.ts, 'string');
  assert.ok(securityRecord.ts.length > 0, 'the record must be timestamped');
  assert.equal(securityRecord.method, 'GET');
  assert.equal(securityRecord.path, '/');

  // The client address is what makes per-client abuse attributable. Its exact
  // form is not pinned: loopback presents as an IPv4 or an IPv4-mapped IPv6
  // address depending on how the socket was opened.
  assert.equal(
    typeof securityRecord.ip,
    'string',
    'the record must attribute the rejection to a client address'
  );
  assert.ok(securityRecord.ip.length > 0);

  // The audit trail must not become a disclosure channel of its own.
  assert.equal(securityRecord.stack, undefined);
  assert.equal(securityRecord.body, undefined);
  assert.equal(securityRecord.authorization, undefined);
  assert.equal(securityRecord.cookie, undefined);

  // Guard the guard: a leaked stub on any channel would corrupt the test
  // runner's own reporting, so the restoration is asserted rather than
  // assumed.
  assert.equal(
    process.stdout.write,
    writeBeforeCapture,
    'process.stdout.write was not restored'
  );
  assert.equal(console.log, logBeforeCapture, 'console.log was not restored');
  assert.equal(console.warn, warnBeforeCapture, 'console.warn was not restored');
  assert.equal(console.error, errorBeforeCapture, 'console.error was not restored');
});

/**
 * RFC 9457 Problem Details, and no information disclosure.
 *
 * The rejection is serialised by the single centralised error path, so it has
 * the same `application/problem+json` shape as every other refusal this
 * service issues. A machine-readable rejection is what lets a client
 * distinguish "slow down" from "you are broken" without scraping prose.
 *
 * The document is then scanned for everything it must NOT contain. A `429` is
 * trivially reachable by any unauthenticated client, which makes it a cheap
 * probe: a stack frame, a module path, a dependency version or an echoed
 * client address in this body would hand an attacker reconnaissance for free
 * (CWE-209). The `instance` member is deliberately omitted upstream for the
 * same reason - it would echo the request target back.
 */
test('the 429 body is an RFC 9457 problem document that discloses nothing', async () => {
  const res = await getRoot();
  assert.equal(res.status, TOO_MANY_REQUESTS, 'the budget is expected to be exhausted here');

  const contentType = res.headers['content-type'];
  assert.equal(typeof contentType, 'string');
  assert.ok(
    contentType.startsWith(PROBLEM_MEDIA_TYPE),
    `the rejection must be served as ${PROBLEM_MEDIA_TYPE}, received ${JSON.stringify(
      contentType
    )}`
  );

  const problem = problemDocument(res);

  assert.equal(problem.status, TOO_MANY_REQUESTS, 'the problem document must restate the status');
  assert.equal(typeof problem.type, 'string', 'RFC 9457 requires a type member');
  assert.ok(problem.type.length > 0);
  assert.equal(typeof problem.title, 'string', 'RFC 9457 requires a title member');
  assert.ok(problem.title.length > 0);

  // Members that would disclose internals are absent by construction: the
  // document is built from the resolved status and a static title map only.
  assert.equal(problem.stack, undefined, 'a stack trace must never be serialised');
  assert.equal(problem.instance, undefined, 'instance would echo the request target back');
  assert.equal(problem.detail, undefined, 'no free-text detail is emitted');
  assert.equal(problem.message, undefined);

  const body = responseText(res);

  assert.ok(!body.includes('stack'), 'the body must not mention a stack');
  assert.ok(!body.includes('    at '), 'the body must not contain stack frames');
  assert.ok(!body.includes('node_modules'), 'the body must not disclose module paths');
  assert.ok(
    !body.includes(process.cwd()),
    'the body must not disclose the filesystem layout of the host'
  );
  assert.ok(
    !/\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/.test(body),
    'the body must not contain an absolute filesystem path'
  );
  assert.ok(
    !body.includes('127.0.0.1') && !body.includes('::ffff:') && !body.includes('::1'),
    'the body must not echo the client address back'
  );
  assert.ok(
    !/\d+\.\d+\.\d+/.test(body),
    'the body must not disclose a dependency version string'
  );
  assert.ok(
    !/express|helmet|node\.js/i.test(body),
    'the body must not name the stack that produced it'
  );
});

