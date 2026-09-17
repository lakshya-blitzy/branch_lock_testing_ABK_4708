'use strict';

/**
 * Regression test for V-06 - CORS ENTIRELY UNCONFIGURED.
 *
 * WEAKNESSES CLOSED
 * -----------------
 *   CWE-346  Origin Validation Error
 *   CWE-942  Permissive Cross-domain Policy with Untrusted Domains
 *   CWE-778  Insufficient Logging (the origin-denial half of V-08)
 *
 * Governing standard: OWASP Top 10 2021 A01 Broken Access Control. An origin
 * allow-list is access control, and this file is the check that cross-origin
 * READ access is granted only to the origins an operator enumerated.
 *
 * WHAT WAS BROKEN
 * ---------------
 * The pre-remediation listener never inspected `Origin` and never emitted an
 * `Access-Control-*` header. Probing it confirmed the exposure: `OPTIONS /`
 * carrying `Origin: https://evil.example` and
 * `Access-Control-Request-Method: POST` returned `200` with ZERO
 * `Access-Control-*` headers and, just as importantly, no `Vary: Origin` - so
 * any intermediary cache was free to serve one origin's response to another.
 * `git grep Access-Control-Allow` across the source branch returned zero
 * matches: there was no partial CORS implementation, only absence.
 *
 * ============================ THE NAMED TRAP =============================
 *   THE CONTROL IS THE ABSENCE OF THE `Access-Control-Allow-Origin` HEADER,
 *   NOT THE STATUS CODE.
 *
 * `cors` handles `OPTIONS` in a dedicated branch that ends the response with
 * `optionsSuccessStatus` - verified as `204` in `node_modules/cors/lib/index.js`
 * - for EVERY preflight, including one from a denied origin and one carrying no
 * `Origin` header at all. A denied origin therefore receives `204`, and a
 * denied simple request still receives `200`, because CORS is a policy the
 * BROWSER enforces on the basis of the response headers; the server does not
 * refuse the request. Nothing in this design answers `403`.
 *
 * Consequently:
 *   - a test asserting "a denied origin gets a non-`204`" FAILS against a
 *     correct implementation;
 *   - a test asserting "a denied origin gets `204`" PASSES against a broken
 *     one, because it proves nothing about the header.
 * Every access-control outcome below is therefore asserted on headers. Where a
 * status is asserted at all for the denied preflight it is asserted as
 * membership in the documented set {204, 405} - never a single hard-coded
 * value - because the status depends on whether `src/middleware/security.js`
 * hands `cors` an array/string origin (204 short-circuit) or resolves a falsy
 * origin (fall-through to the method allow-list, 405). A reviewer expecting
 * `403` will otherwise wrongly conclude the control is missing.
 * =========================================================================
 *
 * WHAT THE IMPLEMENTATION ACTUALLY DOES (read, then verified at runtime)
 * ---------------------------------------------------------------------
 * `src/middleware/security.js` passes `origin: resolveOrigin`, a FUNCTION that
 * always resolves the allow-list ARRAY - never a boolean, never `'*'`. An
 * array is truthy even when empty, so `cors` always takes its exact-string
 * comparison branch: it sets `Access-Control-Allow-Origin` only on an exact
 * match and emits `Vary: Origin` unconditionally either way. That is why the
 * denied-path assertions below expect `Vary` to be present: it is a property
 * of this specific configuration, and asserting it locks in the array
 * resolution. Resolving a falsy origin instead would drop `Vary` (reopening
 * the cache-poisoning gap) and push preflight onto the method allow-list,
 * where a legitimate allow-listed origin would be answered `405`.
 *
 * HARNESS
 * -------
 * CommonJS (the root `package.json` declares no `type`), the built-in
 * `node:test` runner with `node:assert/strict`, and `supertest` driving the
 * exported Express app IN-PROCESS - no port is bound by this file, so it can
 * never collide with a running service or with a sibling suite. Run it with
 * the QUOTED GLOB form that the `test` script in `package.json` uses; the
 * directory form `node --test test/` fails on this runtime with
 * MODULE_NOT_FOUND, which would make a working suite look broken.
 *
 * SCOPE
 * -----
 * This file owns the cross-origin policy and the origin-denial audit record
 * only. Security response headers belong to `test/security/headers.test.js`,
 * the method matrix to `input-validation.test.js`, throttling to
 * `rate-limit.test.js`, and the byte-exact body contract to
 * `behavior-preservation.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/* -------------------------------------------------------------------------
 * Module-scope environment. THIS MUST PRECEDE `require('../../server.js')`.
 *
 * `config/security.js` reads `process.env` exactly once, at ITS require time,
 * and freezes what it resolved. Setting these in a `before()` hook would
 * therefore have no effect whatsoever: the app would already have been built
 * against the deny-all default and every assertion below would silently be
 * testing an unconfigured service. `node --test` gives each test FILE its own
 * child process, so neither variable can leak into a sibling suite.
 * ---------------------------------------------------------------------- */

/** Allow-listed origin, taken from the verification commands in the plan. */
const ALLOWED_ORIGIN = 'https://app.example.com';

/** A second allow-listed origin, so comma-separated parsing is exercised. */
const SECOND_ALLOWED_ORIGIN = 'https://admin.example.com';

/** The rogue origin the original service handed a `200` and no headers. */
const DENIED_ORIGIN = 'https://evil.example';

// A space after the comma is deliberate: the resolver must trim entries.
process.env.ALLOWED_ORIGINS = ALLOWED_ORIGIN + ', ' + SECOND_ALLOWED_ORIGIN;

// Raise the throttling budget far above anything this file issues. With the
// production default of 100 requests per 15 minutes, a later CORS assertion
// would be answered `429` by the rate limiter and fail for a reason that has
// nothing to do with cross-origin policy. Throttling is `rate-limit.test.js`'s
// subject, not this file's.
process.env.RATE_LIMIT_MAX = '1000000';

/* -------------------------------------------------------------------------
 * Subject under test. Requiring `server.js` binds no socket: its `listen()`
 * call is guarded by `require.main === module`.
 * ---------------------------------------------------------------------- */

const { app } = require('../../server.js');
const cfg = require('../../config/security.js');
const { SECURITY_EVENTS } = require('../../src/middleware/logging.js');

/* -------------------------------------------------------------------------
 * Constants and inlined helpers. `test/security/` holds exactly six test
 * files - no `helpers.js`, no fixtures, no runner configuration - so every
 * helper this file needs lives here.
 * ---------------------------------------------------------------------- */

/** Relative specifier of the configuration module, used for cache purging. */
const CONFIG_MODULE = '../../config/security.js';

/** The response contract the hardening had to preserve, byte for byte. */
const GREETING_BODY = 'Hello, World!\n';

/** The one literal that would fail V-06 open by admitting every origin. */
const WILDCARD = '*';

/** Documented statuses a denied preflight may carry. See THE NAMED TRAP. */
const DENIED_PREFLIGHT_STATUSES = [204, 405];

/**
 * Verbs that must never be advertised to a cross-origin caller. The service
 * implements only `GET` and `HEAD`; advertising a mutating verb would invite
 * exactly the cross-origin writes the allow-list exists to prevent, and
 * `TRACE`/`TRACK`/`CONNECT` are verbs whose rejection is itself a control.
 */
const NEVER_ADVERTISED_METHODS = Object.freeze([
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'TRACE',
  'TRACK',
  'CONNECT',
]);

/**
 * Pristine output channels, captured before any test can stub them. The final
 * test asserts these exact function identities are back in place, because a
 * leaked stub would corrupt the test runner's own reporting.
 */
const PRISTINE_STDOUT_WRITE = process.stdout.write;
const PRISTINE_CONSOLE_LOG = console.log;
const PRISTINE_CONSOLE_WARN = console.warn;
const PRISTINE_CONSOLE_ERROR = console.error;

/**
 * Split a comma-separated header field value into trimmed, upper-cased tokens.
 *
 * @param {string|undefined} value Raw header value.
 * @returns {string[]} Tokens, or an empty array when the header is absent.
 */
const headerTokens = (value) => {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== '');
};

/**
 * Whether `Vary` lists `Origin`.
 *
 * A containment check rather than an equality check: `Vary` is a list, and
 * `cors` or any later middleware may legitimately append another field name
 * (for example `Access-Control-Request-Headers`). What matters for cache
 * correctness is that `Origin` is a member.
 *
 * @param {import('supertest').Response} res Response under assertion.
 * @returns {boolean} True when `Origin` is one of the `Vary` tokens.
 */
const varyListsOrigin = (res) => headerTokens(res.headers.vary).includes('ORIGIN');

/**
 * Assert the response never advertises the permissive wildcard.
 *
 * `Access-Control-Allow-Origin: *` would nominally satisfy "configure CORS"
 * while leaving V-06 entirely unremediated, so it is checked on every response
 * this file observes rather than in one place.
 *
 * @param {import('supertest').Response} res Response under assertion.
 * @param {string} label Context for the failure message.
 * @returns {undefined}
 */
const assertNoWildcardOrigin = (res, label) => {
  assert.notEqual(
    res.headers['access-control-allow-origin'],
    WILDCARD,
    label + ': Access-Control-Allow-Origin must never be "*" - a wildcard admits every origin'
  );
  return undefined;
};

/**
 * Run `work` with every stdout channel observed, then restore all of them.
 *
 * `src/middleware/logging.js` emits one single-line JSON object per record
 * through `console.log`, which itself writes through `process.stdout.write`.
 * Both channels are wrapped, so the assertion holds whichever the logger uses.
 *
 * THE SPY IS NON-DESTRUCTIVE, AND THAT IS NOT A STYLE CHOICE. Every wrapper
 * below records the output and then FORWARDS it to the pristine channel.
 * Swallowing the output instead breaks the test runner itself: under
 * `node --test` the child process reports its results to the parent over
 * `process.stdout`, so a wrapper that drops writes discards whatever report
 * is flushed inside the capture window. Measured, not theorised - with a
 * swallowing wrapper this file registered 13 tests and `node --test` reported
 * only 12, silently losing the preceding test's result while still exiting 0.
 * A lost PASS today is a lost FAILURE tomorrow.
 *
 * `process.stdout.write`'s `(chunk, encoding, callback)` contract is preserved
 * by forwarding all three arguments and returning the real back-pressure
 * value. Restoration happens in `finally`, so a failing assertion inside
 * `work` cannot leak a wrapper into the runner.
 *
 * @param {() => Promise<unknown>} work Async body to run while capturing.
 * @returns {Promise<string[]>} Captured lines, newline-split, blanks dropped.
 */
const captureStdout = async (work) => {
  const lines = [];

  const record = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        lines.push(line);
      }
    }
  };

  /**
   * Wrap one `console` method so it records and then forwards.
   *
   * @param {Function} original Pristine console method.
   * @returns {Function} Recording pass-through.
   */
  const observeConsole = (original) => {
    return (...args) => {
      record(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
      return original.apply(console, args);
    };
  };

  try {
    process.stdout.write = (chunk, encoding, callback) => {
      record(chunk);
      return PRISTINE_STDOUT_WRITE.call(process.stdout, chunk, encoding, callback);
    };
    console.log = observeConsole(PRISTINE_CONSOLE_LOG);
    console.warn = observeConsole(PRISTINE_CONSOLE_WARN);
    console.error = observeConsole(PRISTINE_CONSOLE_ERROR);

    await work();
  } finally {
    process.stdout.write = PRISTINE_STDOUT_WRITE;
    console.log = PRISTINE_CONSOLE_LOG;
    console.warn = PRISTINE_CONSOLE_WARN;
    console.error = PRISTINE_CONSOLE_ERROR;
  }

  return lines;
};

/**
 * Parse captured lines and return every one that is a JSON object.
 *
 * The logger emits a per-request record as well as security events, so a
 * caller must search the captured lines rather than assume a single one.
 * Anything unparseable is skipped rather than failing the parse pass.
 *
 * @param {string[]} lines Captured output lines.
 * @returns {Object[]} Parsed records, in emission order.
 */
const parseJsonLines = (lines) => {
  const records = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Not a JSON record; the runner's own output is expected here.
    }
  }
  return records;
};

/**
 * Drop the cached configuration module so the next `require` re-reads
 * `process.env`. ONLY `config/security.js` is purged: the already-built app
 * keeps its frozen configuration, which is exactly what makes the fail-closed
 * check below an isolated assertion about the resolver rather than a rebuild
 * of the pipeline.
 *
 * @returns {undefined}
 */
const purgeConfigCache = () => {
  delete require.cache[require.resolve(CONFIG_MODULE)];
  return undefined;
};

/* =========================================================================
 * Precondition. This test exists because of the load-order trap: if the
 * module-scope assignment above ever stops reaching the resolver, every other
 * assertion in this file would quietly be exercising a deny-all service and
 * the "denied origin" tests would pass for the wrong reason. Failing here
 * first makes that failure mode loud instead of silent.
 * ====================================================================== */

test('the allow-list resolved from the module-scope environment, trimmed and de-duplicated', () => {
  assert.deepEqual(
    [...cfg.cors.allowedOrigins],
    [ALLOWED_ORIGIN, SECOND_ALLOWED_ORIGIN],
    'ALLOWED_ORIGINS must be read before server.js is required; a before() hook is too late'
  );
  assert.ok(
    !cfg.cors.allowedOrigins.includes(WILDCARD),
    'the resolved allow-list must never contain the permissive wildcard'
  );
});

/* =========================================================================
 * 4.1 - Allowed origin, simple request.
 * ====================================================================== */

test('an allow-listed origin receives Access-Control-Allow-Origin and Vary: Origin', async () => {
  const res = await request(app).get('/').set('Origin', ALLOWED_ORIGIN);

  assert.equal(
    res.headers['access-control-allow-origin'],
    ALLOWED_ORIGIN,
    'an enumerated origin must be granted browser read access by exact echo'
  );
  assertNoWildcardOrigin(res, 'allowed simple request');

  // `Vary: Origin` is asserted HERE, on a response that actually carries
  // `Access-Control-Allow-Origin`, because that is where it does the work:
  // without it an intermediary cache could serve this origin's grant to a
  // different origin. The pre-remediation service emitted no `Vary` at all.
  assert.ok(
    varyListsOrigin(res),
    'Vary must list Origin on any response whose ACAO depends on the request Origin'
  );

  // The hardening must not have altered the service contract.
  assert.equal(res.status, 200);
  assert.equal(res.text, GREETING_BODY);
});

test('the second allow-listed origin is honoured, proving comma-separated parsing', async () => {
  const res = await request(app).get('/').set('Origin', SECOND_ALLOWED_ORIGIN);

  assert.equal(res.headers['access-control-allow-origin'], SECOND_ALLOWED_ORIGIN);
  assertNoWildcardOrigin(res, 'second allowed origin');
  assert.ok(varyListsOrigin(res), 'Vary must list Origin for the second allow-listed origin too');
  assert.equal(res.status, 200);
});

/* =========================================================================
 * 4.2 - Denied origin, simple request. THIS IS THE CORE CONTROL.
 * ====================================================================== */

test('a rogue origin receives NO Access-Control-Allow-Origin - the control', async () => {
  const res = await request(app).get('/').set('Origin', DENIED_ORIGIN);

  // The whole of V-06's remediation, in one assertion: the header that would
  // grant a browser read access is simply not there.
  assert.equal(
    res.headers['access-control-allow-origin'],
    undefined,
    'a non-allow-listed origin must never receive Access-Control-Allow-Origin'
  );
  assertNoWildcardOrigin(res, 'denied simple request');

  // The request itself is NOT refused, and that is correct rather than a
  // shortfall. CORS is enforced by the browser on the basis of the response
  // headers: the BROWSER denies the rogue page read access because the grant
  // is absent, while a non-browser client (curl, this test) legitimately still
  // receives the response. No part of this design answers 403 here.
  assert.equal(res.status, 200, 'the server does not refuse the request; the browser denies the read');
  assert.equal(res.text, GREETING_BODY);

  // `Vary: Origin` IS present on the denied path, and asserting it pins the
  // one thing in `resolveOrigin` that must not change: it resolves the
  // allow-list ARRAY, so `cors` takes its comparison branch and emits `Vary`
  // unconditionally. Resolving a falsy origin instead would drop `Vary` -
  // reopening the cache-poisoning gap - and would push preflight onto the
  // method allow-list, breaking it for legitimately allow-listed origins.
  assert.ok(varyListsOrigin(res), 'Vary must list Origin even when the origin is denied');
});

test('origin matching is exact: scheme, host, port and case variants are all denied', async () => {
  const nearMisses = [
    'http://app.example.com', // scheme downgrade
    'https://app.example.com.evil.example', // attacker-controlled suffix
    'https://evil.app.example.com', // attacker-controlled subdomain
    'https://app.example.com:8443', // different port is a different origin
    'https://APP.example.com', // case variant; matching is byte-exact
    'null', // opaque origin, as sent by a sandboxed iframe or file://
  ];

  for (const origin of nearMisses) {
    const res = await request(app).get('/').set('Origin', origin);

    assert.equal(
      res.headers['access-control-allow-origin'],
      undefined,
      'origin "' + origin + '" is not an enumerated entry and must receive no grant'
    );
    assertNoWildcardOrigin(res, 'near-miss origin ' + origin);
  }
});

/* =========================================================================
 * 4.3 - No `Origin` header at all.
 * ====================================================================== */

test('a request with no Origin header receives no CORS grant', async () => {
  const res = await request(app).get('/');

  // A same-origin or non-browser caller needs no cross-origin grant, and
  // emitting one unprompted would widen the policy for no reason.
  assert.equal(
    res.headers['access-control-allow-origin'],
    undefined,
    'no Origin header means no Access-Control-Allow-Origin'
  );
  assertNoWildcardOrigin(res, 'request without Origin');
  assert.equal(res.status, 200);
  assert.equal(res.text, GREETING_BODY);
});

/* =========================================================================
 * 4.4 - Preflight.
 * ====================================================================== */

test('an allow-listed preflight succeeds with a least-privilege method and header policy', async () => {
  const res = await request(app)
    .options('/')
    .set('Origin', ALLOWED_ORIGIN)
    .set('Access-Control-Request-Method', 'GET');

  // This assertion is also the regression test for middleware Ordering Rule 2:
  // `cors` MUST precede the top-level method allow-list. `OPTIONS` is not a
  // member of the allow-list, so if the method guard ran first this preflight
  // would be answered `405` and cross-origin access would be broken for a
  // LEGITIMATE, enumerated origin - defeating the very requirement the CORS
  // policy implements.
  assert.equal(res.status, 204, 'a preflight from an allow-listed origin must be answered, not rejected');
  assert.equal(res.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  assertNoWildcardOrigin(res, 'allowed preflight');
  assert.ok(varyListsOrigin(res), 'Vary must list Origin on the preflight response as well');

  const allowedMethods = headerTokens(res.headers['access-control-allow-methods']);
  assert.ok(allowedMethods.length > 0, 'Access-Control-Allow-Methods must be present on a preflight');

  // Least privilege: the advertised methods are exactly the verbs the service
  // implements, and no mutating or control-rejected verb is among them.
  assert.deepEqual(
    [...allowedMethods].sort(),
    [...cfg.methods.allowed].map((method) => method.toUpperCase()).sort(),
    'the advertised methods must equal the configured allow-list, nothing wider'
  );
  for (const verb of NEVER_ADVERTISED_METHODS) {
    assert.ok(
      !allowedMethods.includes(verb),
      'Access-Control-Allow-Methods must not advertise ' + verb
    );
  }

  // Permitted request headers are constrained too, rather than reflected back
  // from `Access-Control-Request-Headers`, which would be strictly wider.
  const allowedHeaders = headerTokens(res.headers['access-control-allow-headers']);
  assert.ok(allowedHeaders.length > 0, 'Access-Control-Allow-Headers must be present on a preflight');
  assert.ok(
    !allowedHeaders.includes(WILDCARD),
    'Access-Control-Allow-Headers must not be a wildcard'
  );
  assert.ok(
    !allowedHeaders.includes('AUTHORIZATION'),
    'the service has no authentication surface and must not invite an Authorization header'
  );

  // `credentials` is false, so no credential grant is ever advertised.
  assert.equal(
    res.headers['access-control-allow-credentials'],
    undefined,
    'Access-Control-Allow-Credentials must not be emitted: there is no authenticated surface'
  );
});

test('a rogue preflight receives NO Access-Control-Allow-Origin', async () => {
  const res = await request(app)
    .options('/')
    .set('Origin', DENIED_ORIGIN)
    .set('Access-Control-Request-Method', 'POST');

  // ------------------------- THE NAMED TRAP -------------------------------
  // The control is the ABSENCE of the grant header, not the status code.
  // `cors` short-circuits every `OPTIONS` request with `optionsSuccessStatus`
  // (204), so a denied preflight is answered 204 as well; were `resolveOrigin`
  // to resolve a falsy origin, the same request would instead fall through to
  // the method allow-list and be answered 405. Both are correct outcomes of
  // the documented design, and NEITHER proves anything about access control -
  // which is why the status is only checked for membership in the documented
  // set, and why no assertion here expects 403.
  assert.equal(
    res.headers['access-control-allow-origin'],
    undefined,
    'a rogue preflight must never receive Access-Control-Allow-Origin'
  );
  assertNoWildcardOrigin(res, 'denied preflight');

  assert.ok(
    DENIED_PREFLIGHT_STATUSES.includes(res.status),
    'a denied preflight must carry one of the documented statuses ' +
      JSON.stringify(DENIED_PREFLIGHT_STATUSES) +
      ', but the status is not the control; observed ' +
      res.status
  );

  // The requested verb is never granted, whatever the status.
  const allowedMethods = headerTokens(res.headers['access-control-allow-methods']);
  assert.ok(!allowedMethods.includes('POST'), 'POST must never be advertised to any origin');
});

/* =========================================================================
 * 4.5 - The fail-closed default, proved in isolation.
 * ====================================================================== */

test('an unset ALLOWED_ORIGINS resolves to an empty allow-list: deny all, never wildcard', () => {
  const saved = process.env.ALLOWED_ORIGINS;

  try {
    // This file necessarily sets ALLOWED_ORIGINS, which masks the default, so
    // the default is exercised directly: drop the variable, purge ONLY the
    // configuration module from the require cache, and re-resolve.
    delete process.env.ALLOWED_ORIGINS;
    purgeConfigCache();

    const unconfigured = require(CONFIG_MODULE);

    assert.ok(Array.isArray(unconfigured.cors.allowedOrigins), 'the allow-list must always be an array');
    assert.deepEqual(
      [...unconfigured.cors.allowedOrigins],
      [],
      'an unconfigured deployment must deny every cross-origin caller'
    );

    // Fail-closed, per the security-fix discipline: absent configuration must
    // produce the RESTRICTIVE outcome. Falling back to a permissive `*` would
    // nominally satisfy "configure CORS" while leaving V-06 entirely
    // unremediated, so the empty list must never contain - or become - one.
    assert.ok(
      !unconfigured.cors.allowedOrigins.includes(WILDCARD),
      'the deny-all default must never fall back to a permissive wildcard'
    );
  } finally {
    // Restore the environment and the cache so test order cannot matter.
    if (saved === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = saved;
    }
    purgeConfigCache();
  }

  // Restoration is itself asserted: a later require must see this file's
  // allow-list again, exactly as the module-scope assignment left it.
  const restored = require(CONFIG_MODULE);
  assert.deepEqual([...restored.cors.allowedOrigins], [ALLOWED_ORIGIN, SECOND_ALLOWED_ORIGIN]);
});

test('no response on any path this file exercises ever advertises the wildcard origin', async () => {
  const probes = [
    request(app).get('/'),
    request(app).get('/').set('Origin', ALLOWED_ORIGIN),
    request(app).get('/').set('Origin', DENIED_ORIGIN),
    request(app).options('/').set('Origin', ALLOWED_ORIGIN).set('Access-Control-Request-Method', 'GET'),
    request(app).options('/').set('Origin', DENIED_ORIGIN).set('Access-Control-Request-Method', 'POST'),
    request(app).options('/').set('Access-Control-Request-Method', 'GET'),
  ];

  for (const probe of probes) {
    const res = await probe;
    assertNoWildcardOrigin(res, 'wildcard sweep');
  }
});

/* =========================================================================
 * 4.6 - V-08: the origin denial must leave an audit record (CWE-778).
 * ====================================================================== */

test('a denied origin emits a structured security event so origin probing is detectable', async () => {
  // The event name is part of the wire contract downstream log analysis keys
  // on, so both the constant and its literal value are pinned.
  assert.equal(
    SECURITY_EVENTS.CORS_ORIGIN_DENIED,
    'security.cors_origin_denied',
    'the origin-denial event name must not drift; log analysis matches on it exactly'
  );

  let response;
  const lines = await captureStdout(async () => {
    response = await request(app).get('/').set('Origin', DENIED_ORIGIN);
  });

  // The denial itself still holds while output is captured.
  assert.equal(response.headers['access-control-allow-origin'], undefined);

  // The logger emits a per-request record alongside the security event, so the
  // captured lines are searched rather than assumed to be a single line.
  const records = parseJsonLines(lines);
  assert.ok(records.length > 0, 'at least one structured JSON record must be emitted');

  const denial = records.find(
    (entry) => entry.kind === 'security' && entry.event === SECURITY_EVENTS.CORS_ORIGIN_DENIED
  );

  // Without this record, origin probing is invisible: an attacker can sweep
  // origins indefinitely and nothing in the system would ever show it.
  assert.ok(
    denial !== undefined,
    'an origin denial must emit a kind="security" record carrying event=' +
      SECURITY_EVENTS.CORS_ORIGIN_DENIED +
      '; captured: ' +
      JSON.stringify(lines)
  );
  assert.equal(denial.level, 'warn', 'a denial is a warning-level security event');
  assert.equal(denial.origin, DENIED_ORIGIN, 'the record must name the origin that was refused');
  assert.equal(typeof denial.ts, 'string', 'every record carries an ISO-8601 timestamp');
  assert.ok(denial.ts.length > 0, 'the timestamp must not be empty');
});

/* =========================================================================
 * Harness hygiene. Both checks are order-independent: they assert that
 * nothing this file did to the process is still in effect.
 * ====================================================================== */

test('the log-capture helper restored every output channel it wrapped', () => {
  // A leaked stub would swallow or corrupt the test runner's own output and
  // could make a subsequent failure invisible.
  assert.equal(process.stdout.write, PRISTINE_STDOUT_WRITE, 'process.stdout.write must be restored');
  assert.equal(console.log, PRISTINE_CONSOLE_LOG, 'console.log must be restored');
  assert.equal(console.warn, PRISTINE_CONSOLE_WARN, 'console.warn must be restored');
  assert.equal(console.error, PRISTINE_CONSOLE_ERROR, 'console.error must be restored');
});

test('the fail-closed check left the environment and the require cache as it found them', () => {
  assert.equal(
    process.env.ALLOWED_ORIGINS,
    ALLOWED_ORIGIN + ', ' + SECOND_ALLOWED_ORIGIN,
    'ALLOWED_ORIGINS must be exactly as the module scope set it'
  );
  assert.deepEqual(
    [...require(CONFIG_MODULE).cors.allowedOrigins],
    [ALLOWED_ORIGIN, SECOND_ALLOWED_ORIGIN],
    'the cached configuration must resolve the allow-list this file set'
  );
});
