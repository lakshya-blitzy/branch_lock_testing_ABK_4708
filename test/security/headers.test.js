'use strict';

/**
 * V-01 regression suite - HTTP security response headers.
 *
 * THE FINDING THIS FILE MAKES PERMANENT
 * -------------------------------------
 * V-01, missing HTTP security response headers: CWE-693 (Protection
 * Mechanism Failure), CWE-1021 (Improper Restriction of Rendered UI Layers)
 * and CWE-16 (Configuration). Before the fix, probing the running listener
 * showed a `GET /` response carrying only `Content-Type`, `Date`,
 * `Connection`, `Keep-Alive` and `Content-Length` - no CSP, no HSTS, no
 * `X-Frame-Options`, no `X-Content-Type-Options`, no `Referrer-Policy`, no
 * COOP, no CORP and no COEP (AAP section 0.2.2.1). The root cause was
 * structural rather than a misconfiguration: the 14-line `http` listener set
 * exactly one header, so no defensive header COULD be present.
 *
 * A repository-wide search for `helmet`, `Strict-Transport`,
 * `Content-Security-Policy`, `X-Frame-Options`, `nosniff` or
 * `Referrer-Policy` returned zero matches on the source branch. Every header
 * asserted below is newly introduced, so a failure here means the control is
 * ABSENT, not merely misconfigured.
 *
 * WHAT IS ASSERTED, AND WHY THAT IS THE COMPLETE CHECK
 * ----------------------------------------------------
 * THIRTEEN response headers are expected: the twelve `helmet@8.3.0` defaults
 * plus the explicitly opted-in `Cross-Origin-Embedder-Policy`, which helmet
 * does NOT set by default. The exact values are fixed by AAP section 0.5.1.3
 * and were re-verified against the running application before this file was
 * written (AAP section 0.12.1, "Verify, do not assume"), so nothing here is
 * taken from documentation alone.
 *
 * The same thirteen headers are then asserted on a `405` and on a `404`
 * response. That is not duplication - it is the test of Ordering Rule 1
 * (AAP section 0.5.1.1): `helmet` is mounted FIRST in `src/app.js`, ahead of
 * every other stage, precisely so the headers reach `404`, `405`, `413`,
 * `429` and `500` responses as well as successful ones. Error responses are
 * exactly what an attacker probes most. Mounting helmet beside the route
 * handler would satisfy a `200`-only suite while leaving every error path
 * bare, so the error-response section below is what closes that gap.
 *
 * GOVERNING STANDARDS (provenance category 3, best practice in lieu of
 * rules - no user rule governs this file; `review_rules` returns exactly
 * "No user rules provided.", matching AAP section 0.11)
 *   * OWASP Secure Headers Project - governs requirement R1 and therefore
 *     the entire expected header set, including the deliberate retention of
 *     `X-XSS-Protection: 0` and the explicit COEP opt-in. This file is the
 *     mechanical check that the service's header posture matches that
 *     guidance.
 *   * OWASP Top 10 2021 A05, Security Misconfiguration - missing defensive
 *     headers are the canonical A05 instance; asserting them on ERROR
 *     responses as well as successful ones is what makes this check complete
 *     rather than cosmetic.
 *
 * LOAD ORDER - THE ONE THING THAT BREAKS THIS FILE SILENTLY
 * ---------------------------------------------------------
 * `config/security.js` reads `process.env` ONCE at require time and freezes
 * its export; `server.js` requires it at load. Every `process.env`
 * assignment below therefore sits at MODULE SCOPE, BEFORE
 * `require('../../server.js')`. The same assignment inside `before()` or a
 * test body would do nothing at all, and the suite would silently run
 * against whatever configuration the ambient environment happened to supply.
 *
 * `node --test` runs each test file in its own child process, so this
 * per-file environment setup cannot leak into the other five security
 * suites.
 *
 * HARNESS
 * -------
 * CommonJS (`package.json` declares no `type` field), the built-in
 * `node:test` runner with `node:assert/strict`, and `supertest` driving the
 * exported Express application IN-PROCESS - no port is bound by this file,
 * so it cannot collide with a running service or with a sibling suite.
 * Invoke through the quoted-glob `test` script in `package.json`; the
 * directory form `node --test test/` fails on this runtime with
 * `MODULE_NOT_FOUND`. (The glob itself is not written out here because the
 * sequence it contains would close this comment.)
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

/* -------------------------------------------------------------------------
 * Configuration for this suite - MODULE SCOPE, BEFORE `server.js` IS
 * REQUIRED. See "LOAD ORDER" above; moving any line below into a hook makes
 * it a no-op.
 * ---------------------------------------------------------------------- */

// Rate-limit cross-contamination is a real failure mode for a header suite:
// it issues several requests, and a limiter that ran out of budget would
// convert a header assertion into a spurious `429` - a green-looking suite
// asserting the wrong response, or a red one blaming the wrong control. A
// budget far above anything this file can consume removes the interaction
// entirely. `rate-limit.test.js` is the only suite that wants a small
// budget, and it runs in its own process.
process.env.RATE_LIMIT_MAX = '1000000';

// The three variables below are cleared so the suite exercises the SHIPPED
// DEFAULTS and is hermetic with respect to the ambient environment:
//   ALLOWED_METHODS  - the `405` probe depends on `POST` being outside the
//                      default `GET, HEAD` allow-list. An inherited value
//                      including `POST` would turn that probe into a `404`
//                      from the route table and assert nothing about
//                      method filtering.
//   HSTS_MAX_AGE     - the expected `Strict-Transport-Security` value is
//                      derived from configuration below AND the default is
//                      asserted to be 31536000, so the default path must be
//                      the one under test.
//   TLS_ENABLED      - requiring `server.js` with TLS enabled but no
//                      readable key material fails closed by design. This
//                      suite needs no transport at all (supertest is
//                      in-process), and HSTS is emitted unconditionally, so
//                      cleartext is the correct and sufficient setting.
delete process.env.ALLOWED_METHODS;
delete process.env.HSTS_MAX_AGE;
delete process.env.TLS_ENABLED;

const { app } = require('../../server.js');
const cfg = require('../../config/security.js');

/* -------------------------------------------------------------------------
 * Expected header set.
 * ---------------------------------------------------------------------- */

/**
 * Thirteen headers in total: the twelve `helmet@8.3.0` defaults plus the
 * opted-in `Cross-Origin-Embedder-Policy`. Counted explicitly, and checked
 * against the tables below by a test, so a future edit cannot quietly drop
 * one from coverage.
 *
 * Eleven are single fixed values (`EXACT_VALUE_HEADERS`), one is the
 * multi-directive Content Security Policy (`EXPECTED_CSP_DIRECTIVES`) and one
 * is COEP (`EXPECTED_COEP`): 11 + 1 + 1 = 13.
 */
const EXPECTED_SECURITY_HEADER_COUNT = 13;

/** `config/security.js` default for `HSTS_MAX_AGE`, in seconds (one year). */
const DEFAULT_HSTS_MAX_AGE = 31536000;

/**
 * The expected `Strict-Transport-Security` value, DERIVED from configuration
 * rather than hard-coded a second time, so this suite stays in step with
 * `config/security.js` instead of drifting from it. The shipped defaults are
 * asserted separately below, which is what keeps the derivation honest.
 *
 * HSTS is emitted unconditionally, including over plain HTTP where browsers
 * ignore it. That is deliberate (AAP section 0.12.2): it removes the class of
 * bug where the header is forgotten at the moment TLS is switched on. Do NOT
 * add an assertion expecting HSTS to be absent while TLS is disabled.
 */
const expectedStrictTransportSecurity =
  'max-age=' + cfg.hsts.maxAge + (cfg.hsts.includeSubDomains ? '; includeSubDomains' : '');

/**
 * The eleven headers with a single exact value. Keys are LOWER-CASE because
 * Node normalises response header names on `res.headers`; indexing with
 * canonical casing would read `undefined` and pass nothing.
 */
const EXACT_VALUE_HEADERS = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': expectedStrictTransportSecurity,
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',

  // `X-XSS-Protection: 0` IS CORRECT - it is not a defect and must never
  // become `1; mode=block`. Current guidance disables the legacy XSS
  // auditor, which itself introduced vulnerabilities; helmet@8 therefore
  // sets `0` by default. This is the single line in this file a future
  // reviewer is most likely to "fix" wrongly (AAP section 0.5.1.3).
  'x-xss-protection': '0',
});

/**
 * Every directive the default `helmet@8.3.0` Content Security Policy emits.
 *
 * Asserted directive by directive rather than as one giant string equality,
 * so a failure names the directive that regressed and the check is not
 * defeated by directive re-ordering or by whitespace. Note that helmet joins
 * directives with `;` and NO following space - observed on the running
 * application - which is exactly why the parser below splits and trims
 * instead of matching a formatted substring.
 *
 * The policy is moot today: `default-src 'self'` has no practical effect on a
 * `text/plain` response. It is retained deliberately at helmet's default
 * because it costs nothing now and constrains any future HTML surface BY
 * DEFAULT rather than by somebody remembering to add it (AAP section 0.12.2).
 */
const EXPECTED_CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' https: data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' https: 'unsafe-inline'",
  'upgrade-insecure-requests',
]);

/**
 * The opted-in `Cross-Origin-Embedder-Policy`.
 *
 * `src/middleware/security.js` passes `crossOriginEmbedderPolicy: true`,
 * which yields `require-corp`. Helmet does NOT set COEP by default, so this
 * one assertion is what proves the explicit opt-in was not forgotten: remove
 * the option and the control disappears silently, with every other header
 * still present (AAP sections 0.5.1.3 and 0.8.1.2).
 */
const EXPECTED_COEP = 'require-corp';

/**
 * The two `4xx` probes that prove Ordering Rule 1.
 *
 * `POST /` is refused by the top-level method allow-list, which SHORT-CIRCUITS
 * into the centralised error handler; every stage mounted behind it is never
 * reached. Demoting the header stage even one position - verified by
 * deliberately doing so and re-running this suite - leaves that `405` bare
 * while `GET /` still looks perfectly hardened. `GET /nope` is answered by the
 * terminal not-found handler at the far end of the chain, covering the other
 * shape of rejection: one that traverses the whole pipeline before failing.
 * Between them the two probes cover both ways a `4xx` is produced here.
 */
const ERROR_PROBES = Object.freeze([
  Object.freeze({
    label: 'POST / -> 405 (method allow-list)',
    method: 'post',
    path: '/',
    status: 405,
  }),
  Object.freeze({
    label: 'GET /nope -> 404 (terminal not-found handler)',
    method: 'get',
    path: '/nope',
    status: 404,
  }),
]);

/* -------------------------------------------------------------------------
 * DELIBERATELY NOT ASSERTED - benign deltas and other suites' territory
 * (AAP sections 0.8.3.4 and 0.9.1). Adding any of these would produce a
 * failing suite against a CORRECT implementation:
 *
 *   * `content-type === 'text/plain'` - Express normalises it to
 *     `text/plain; charset=utf-8` on the `200`, and the error handler
 *     serialises RFC 9457 `application/problem+json` on the `4xx`. The body
 *     and media type are owned by `behavior-preservation.test.js`.
 *   * the ABSENCE of `etag` - Express computes a weak entity tag
 *     automatically. Harmless, and standard HTTP behaviour.
 *   * `x-xss-protection: 1; mode=block` - see the note on that header above;
 *     `0` is the correct current value.
 *   * any `Access-Control-*` header - `cors.test.js` owns those, and no
 *     `Origin` header is sent from here, so cross-origin behaviour is not
 *     what these probes exercise.
 *   * `RateLimit` / `RateLimit-Policy` / `Retry-After` - `rate-limit.test.js`
 *     owns those; this suite deliberately raises the budget out of the way.
 *   * the absence of HSTS while TLS is disabled - it is emitted
 *     unconditionally by design.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Inline assertion helpers.
 *
 * Kept in this file rather than a shared module because `test/security/`
 * holds exactly six files and no helper module (AAP section 0.9.1). The
 * `200` path and both `4xx` paths call the SAME functions, which is what
 * guarantees the error responses receive identical coverage rather than a
 * hand-copied subset.
 * ---------------------------------------------------------------------- */

/**
 * Collapse runs of whitespace and trim, so a directive is compared on its
 * content rather than on its formatting.
 *
 * @param {string} value Raw header fragment.
 * @returns {string} Normalised fragment.
 */
const normaliseWhitespace = (value) => value.replace(/\s+/g, ' ').trim();

/**
 * Parse a Content-Security-Policy header into its set of directives.
 *
 * Splitting on `;` and trimming tolerates both `a; b` and helmet's actual
 * `a;b` output, and set membership makes the check independent of directive
 * order.
 *
 * @param {string} header Raw `Content-Security-Policy` value.
 * @returns {Set<string>} Normalised directives.
 */
const parseCspDirectives = (header) =>
  new Set(
    header
      .split(';')
      .map(normaliseWhitespace)
      .filter((directive) => directive !== '')
  );

/**
 * Assert the eleven single-value security headers.
 *
 * @param {Object} res Supertest response.
 * @param {string} label Probe description, quoted in every failure message
 *   so a failure names the response that regressed.
 * @returns {void}
 */
const assertExactValueHeaders = (res, label) => {
  for (const [name, expected] of Object.entries(EXACT_VALUE_HEADERS)) {
    assert.equal(
      res.headers[name],
      expected,
      label + ': expected response header ' + name + ' to be "' + expected + '"'
    );
  }
};

/**
 * Assert the Content Security Policy is present and carries every expected
 * directive.
 *
 * @param {Object} res Supertest response.
 * @param {string} label Probe description for failure messages.
 * @returns {void}
 */
const assertContentSecurityPolicy = (res, label) => {
  const header = res.headers['content-security-policy'];

  assert.equal(
    typeof header,
    'string',
    label + ': expected a Content-Security-Policy response header to be present'
  );
  assert.notEqual(header, '', label + ': Content-Security-Policy must not be empty');

  const directives = parseCspDirectives(header);

  for (const expected of EXPECTED_CSP_DIRECTIVES) {
    assert.ok(
      directives.has(expected),
      label + ': Content-Security-Policy is missing the directive "' + expected + '"'
    );
  }
};

/**
 * Assert the COEP opt-in survived.
 *
 * @param {Object} res Supertest response.
 * @param {string} label Probe description for failure messages.
 * @returns {void}
 */
const assertCrossOriginEmbedderPolicy = (res, label) => {
  assert.equal(
    res.headers['cross-origin-embedder-policy'],
    EXPECTED_COEP,
    label +
      ': expected Cross-Origin-Embedder-Policy to be "' +
      EXPECTED_COEP +
      '". Helmet does not set this header by default, so its absence means the' +
      ' explicit crossOriginEmbedderPolicy opt-in in src/middleware/security.js' +
      ' was dropped'
  );
};

/**
 * Assert the framework fingerprint is suppressed.
 *
 * Express advertises itself through `X-Powered-By` unless told not to;
 * helmet removes it, and `src/app.js` also disables it at the application
 * level as defence in depth. Naming the framework - and, by implication,
 * narrowing its version - hands an attacker free reconnaissance.
 *
 * @param {Object} res Supertest response.
 * @param {string} label Probe description for failure messages.
 * @returns {void}
 */
const assertPoweredByAbsent = (res, label) => {
  assert.equal(
    res.headers['x-powered-by'],
    undefined,
    label + ': X-Powered-By must not be present on any response'
  );
};

/**
 * The complete V-01 header contract, as one call.
 *
 * @param {Object} res Supertest response.
 * @param {string} label Probe description for failure messages.
 * @returns {void}
 */
const assertAllSecurityHeaders = (res, label) => {
  assertExactValueHeaders(res, label);
  assertContentSecurityPolicy(res, label);
  assertCrossOriginEmbedderPolicy(res, label);
  assertPoweredByAbsent(res, label);
};

/* -------------------------------------------------------------------------
 * Preconditions - the configuration the expectations above are derived from.
 * ---------------------------------------------------------------------- */

describe('V-01 preconditions: header configuration', () => {
  it('ships the documented HSTS defaults', () => {
    assert.equal(
      cfg.hsts.maxAge,
      DEFAULT_HSTS_MAX_AGE,
      'HSTS_MAX_AGE must default to ' + DEFAULT_HSTS_MAX_AGE + ' seconds (one year)'
    );
    assert.equal(
      cfg.hsts.includeSubDomains,
      true,
      'includeSubDomains must be enabled, so subdomains inherit the transport pin'
    );
    assert.equal(
      expectedStrictTransportSecurity,
      'max-age=31536000; includeSubDomains',
      'the derived Strict-Transport-Security value must match the value fixed by AAP section 0.5.1.3'
    );
  });

  it('accounts for all thirteen expected security headers', () => {
    const covered =
      Object.keys(EXACT_VALUE_HEADERS).length + // eleven single-value headers
      1 + // Content-Security-Policy, asserted directive by directive
      1; // Cross-Origin-Embedder-Policy, the explicit opt-in

    assert.equal(
      covered,
      EXPECTED_SECURITY_HEADER_COUNT,
      'the tables in this file must cover all ' +
        EXPECTED_SECURITY_HEADER_COUNT +
        ' headers (twelve helmet defaults plus the opted-in COEP); a mismatch means one was dropped from coverage'
    );
  });
});

/* -------------------------------------------------------------------------
 * The successful response.
 * ---------------------------------------------------------------------- */

describe('V-01: security headers on GET / (200)', () => {
  let res;

  before(async () => {
    res = await request(app).get('/');
  });

  it('answers 200, so the assertions below describe the success path', () => {
    assert.equal(res.status, 200, 'GET / must still answer 200');
  });

  it('sets the eleven single-value security headers', () => {
    assertExactValueHeaders(res, 'GET / -> 200');
  });

  it('sets a Content-Security-Policy carrying every default directive', () => {
    assertContentSecurityPolicy(res, 'GET / -> 200');
  });

  it('sets the explicitly opted-in Cross-Origin-Embedder-Policy', () => {
    assertCrossOriginEmbedderPolicy(res, 'GET / -> 200');
  });

  it('suppresses X-Powered-By', () => {
    assertPoweredByAbsent(res, 'GET / -> 200');
  });
});

/* -------------------------------------------------------------------------
 * The error responses - Ordering Rule 1.
 *
 * This section is NOT redundant with the one above. `helmet` is mounted
 * first in `src/app.js` (AAP section 0.5.1.1, Ordering Rule 1) so that the
 * headers reach `405`, `413`, `429`, `404` and `500` responses too, and
 * error responses are exactly what an attacker probes most. Mounting helmet
 * beside the route handler would pass a `200`-only suite while leaving every
 * error path bare - these probes are the test of the ordering rule itself.
 * ---------------------------------------------------------------------- */

describe('V-01: security headers on error responses (Ordering Rule 1)', () => {
  for (const probe of ERROR_PROBES) {
    describe(probe.label, () => {
      let res;

      before(async () => {
        res = await request(app)[probe.method](probe.path);
      });

      it('answers the expected ' + probe.status + ', so a rejection is under test', () => {
        assert.equal(
          res.status,
          probe.status,
          probe.label + ': the probe must produce this rejection, otherwise it asserts nothing about error paths'
        );
      });

      it('carries the complete security header set', () => {
        assertAllSecurityHeaders(res, probe.label);
      });
    });
  }
});
