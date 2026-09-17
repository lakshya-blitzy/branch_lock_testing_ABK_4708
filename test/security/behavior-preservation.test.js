'use strict';

/**
 * THE BEHAVIOUR-PRESERVATION GATE.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The security remediation added twelve response headers, an origin
 * allow-list, a per-client rate limiter, a method allow-list, body ceilings,
 * schema validation, structured logging and an opt-in TLS listener to a
 * service whose entire previous implementation was fourteen lines of raw
 * `http`. Behaviour preservation is therefore "a gate, not an aspiration"
 * (AAP 0.1.2.2), and the backward-compatibility constraint in AAP 0.10.3 is
 * what this file mechanically enforces:
 *
 *   * `GET /` still answers `200` with a body of EXACTLY 14 bytes,
 *     `Hello, World!\n`.
 *   * `node server.js` still starts with no environment variables and no
 *     certificate material anywhere on the machine.
 *   * The default bind is still `127.0.0.1:3000`.
 *
 * It also carries the regression test for V-12: `package.json` declared
 * `"main": "index.js"`, a file that exists nowhere in the repository, so any
 * tool resolving the package entry point failed. `main` must now resolve to a
 * file that actually exists (AAP 0.8.1.2).
 *
 * WHAT THIS FILE IS DELIBERATELY NOT FOR
 * --------------------------------------
 * Every assertion here is about the PRESERVED CONTRACT, never about a
 * security control. The controls have their own five suites - `headers`,
 * `cors`, `rate-limit`, `input-validation` and `tls` - and duplicating them
 * here would blur the one question a reviewer opens this file to answer: did
 * the hardening break anything? There are no dependency or `npm audit`
 * assertions either; `.github/workflows/security-scan.yml` owns that gate.
 *
 * WHY THE ENVIRONMENT BLOCK PRECEDES THE `require`
 * ------------------------------------------------
 * `config/security.js` reads `process.env` exactly ONCE, at require time, and
 * exports a deeply frozen object; `server.js` requires it while loading.
 * Assignments made inside a `before()` hook or a test body are therefore read
 * by nobody. Every `process.env` mutation in this file consequently sits at
 * module scope, textually above `require('../../server.js')`. `node --test`
 * runs each test file in its own child process, so this manipulation is
 * contained to this file and cannot leak into a sibling suite.
 *
 * FINDINGS COVERED: the behaviour contract of AAP 0.8.3.2 and 0.10.3, plus
 * V-12 (dangling package entry point).
 *
 * PROVENANCE: AAP 0.11.1 category 3 - best practice adopted in lieu of rules.
 * No user rule governs this file; `review_rules` reports that no user rules
 * were provided. OWASP ASVS v4 V14 (Configuration) is the standard behind
 * asserting the configuration defaults against `config/security.js` itself
 * rather than trusting documentation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
// `node:https` is required solely to express the NEGATIVE half of the
// transport assertion below - that the default listener is not a TLS server.
// `https.Server` extends `tls.Server`, not `http.Server`, so the two
// `instanceof` checks together pin the transport exactly.
const https = require('node:https');
const request = require('supertest');

/* -------------------------------------------------------------------------
 * Configuration inputs. Module scope, before the require - see the header.
 * ---------------------------------------------------------------------- */

// The limiter's default budget is 100 requests per 15 minutes, and this file
// issues only a handful. The budget is raised anyway so that a stray `429`
// can never turn a behaviour assertion into a spurious failure: this suite
// must fail only when behaviour has actually changed. Only
// `rate-limit.test.js` configures a small budget, and it does so in its own
// child process.
process.env.RATE_LIMIT_MAX = '1000000';

// This suite asserts the DEFAULTS documented in AAP 0.8.3.2, so the variables
// that would override them are removed from this child process rather than
// inherited from whatever shell invoked the runner. Deleting them is what
// makes `cfg.host`, `cfg.port` and `cfg.tls.enabled` statements about
// `config/security.js`'s defaults instead of statements about the ambient
// environment. Note in particular that no `TLS_ENABLED` is ever set here:
// zero-configuration startup is the property under test.
delete process.env.HOST;
delete process.env.PORT;
delete process.env.TLS_ENABLED;
delete process.env.TLS_KEY_PATH;
delete process.env.TLS_CERT_PATH;

const { app, server } = require('../../server.js');
const cfg = require('../../config/security.js');

/* -------------------------------------------------------------------------
 * The contract, as constants. Stated once so no assertion can drift from
 * another, and written as a literal rather than derived from the
 * implementation - a test that recomputes the expected value from the code
 * under test proves nothing.
 * ---------------------------------------------------------------------- */

/** The response body the original `server.js` line 9 wrote, verbatim. */
const EXPECTED_BODY = 'Hello, World!\n';

/**
 * Byte length of that body: `Hello, World!` is thirteen characters and the
 * trailing newline is the fourteenth. This mirrors the `curl … | od -c`
 * check of AAP 0.10.1, which was verified octal-dump-exact, and
 * `printf 'Hello, World!\n' | wc -c`, which reports 14.
 */
const EXPECTED_BYTE_LENGTH = 14;

/**
 * Media type prefix. A PREFIX, matched with a regular expression, because
 * Express 5 normalises the header to `text/plain; charset=utf-8` - see the
 * benign-delta note in the first test below.
 */
const CONTENT_TYPE_PATTERN = /^text\/plain(\s*;|$)/;

/** Default bind host, previously the literal at `server.js` line 3. */
const EXPECTED_HOST = '127.0.0.1';

/** Default bind port, previously the literal at `server.js` line 4. */
const EXPECTED_PORT = 3000;

/** Repository root, resolved from this file's location in `test/security/`. */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** The entry point `package.json` `main` must name after the V-12 fix. */
const EXPECTED_MAIN = 'server.js';

/* -------------------------------------------------------------------------
 * 4.1 / 4.2 - the response contract. The primary gate.
 * ---------------------------------------------------------------------- */

describe('behaviour preservation: the GET / response contract', () => {
  it('answers 200 with the body exactly 14 bytes of "Hello, World!\\n"', async () => {
    const response = await request(app).get('/');

    assert.strictEqual(
      response.status,
      200,
      'GET / must still answer 200; the hardening may reject requests the ' +
        'service never should have accepted, but never the one route it serves.'
    );

    assert.strictEqual(
      response.text,
      EXPECTED_BODY,
      'The response body must be byte-for-byte what the original listener ' +
        'wrote, trailing newline included.'
    );

    assert.strictEqual(
      Buffer.byteLength(response.text, 'utf8'),
      EXPECTED_BYTE_LENGTH,
      'The body must measure exactly 14 bytes. Asserted independently of the ' +
        'string comparison above because byte length is the form the contract ' +
        'was verified in, and an invisible re-encoding would slip past a ' +
        'string equality that a byte count catches.'
    );
  });

  it('still declares text/plain, tolerating the charset Express appends', async () => {
    const response = await request(app).get('/');
    const contentType = response.headers['content-type'];

    assert.ok(
      typeof contentType === 'string' && contentType.length > 0,
      'A Content-Type header must be present, as it was on the original response.'
    );

    // BENIGN DELTAS - DO NOT "TIGHTEN" EITHER OF THESE (AAP 0.8.3.4).
    //
    // 1. Never assert `contentType === 'text/plain'`. Express 5 normalises the
    //    value to `text/plain; charset=utf-8`. The BODY is unchanged; only the
    //    header gains a parameter, and that is a small security improvement
    //    because an explicit charset removes encoding-sniffing ambiguity. A
    //    strict equality here would fail against a correct implementation.
    //
    // 2. Never assert the ABSENCE of `ETag`. Express computes a weak
    //    `ETag: W/"…"` automatically. It is harmless, standard HTTP, and
    //    outside the preserved contract - so this file asserts nothing about
    //    it in either direction.
    assert.match(
      contentType,
      CONTENT_TYPE_PATTERN,
      'Content-Type must still start with text/plain; the charset parameter ' +
        'Express appends is expected and must not be asserted against.'
    );
  });
});

/* -------------------------------------------------------------------------
 * 4.3 - HEAD /, the other verb the allow-list permits.
 * ---------------------------------------------------------------------- */

describe('behaviour preservation: the HEAD / response contract', () => {
  it('answers 200 with no body', async () => {
    const response = await request(app).head('/');

    // `HEAD` is in the default `ALLOWED_METHODS` allow-list (`GET, HEAD`) and
    // Express derives it from the `GET` route, stripping the body. Asserting
    // it here keeps the second permitted verb inside the behaviour gate; the
    // rejection of every OTHER verb belongs to `input-validation.test.js`.
    assert.strictEqual(response.status, 200, 'HEAD / must still answer 200.');

    assert.ok(
      response.text === undefined || response.text === '',
      'A HEAD response must carry no body, per RFC 9110.'
    );
  });
});

/* -------------------------------------------------------------------------
 * 4.4 - V-12: the package entry point resolves to a file that exists.
 * ---------------------------------------------------------------------- */

describe('V-12: the package entry point resolves to a file that exists', () => {
  it('names an existing file in "main"', () => {
    // Read the real manifest from disk rather than `require`-ing it, so the
    // assertion is about the committed bytes and not about a module-cache
    // entry some other suite may have populated.
    const manifestPath = path.join(REPO_ROOT, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(
      typeof manifest.main === 'string' && manifest.main.length > 0,
      'package.json must declare a non-empty "main".'
    );

    assert.strictEqual(
      manifest.main,
      EXPECTED_MAIN,
      'The pre-fix value was "index.js", a file that exists nowhere in this ' +
        'repository; the entry point is server.js.'
    );

    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, manifest.main)),
      'The file named by "main" must exist on disk - that is the whole of V-12.'
    );
  });

  it('resolves through require.resolve without throwing', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

    // `fs.existsSync` proves a path; `require.resolve` proves the runtime's
    // own resolver agrees, which is what every consuming tool actually uses.
    assert.doesNotThrow(
      () => require.resolve(path.join(REPO_ROOT, manifest.main)),
      'Node must be able to resolve the declared entry point.'
    );
  });
});

/* -------------------------------------------------------------------------
 * 4.5 - zero-configuration startup, and the import-time side effect that
 * the in-process harness for all six suites depends on being absent.
 * ---------------------------------------------------------------------- */

describe('behaviour preservation: zero-configuration startup', () => {
  it('leaves TLS off by default, so no certificate is a precondition', () => {
    // This file sets no `TLS_ENABLED` and deleted any inherited value, so a
    // `false` here is the default speaking. HTTPS is opt-in precisely so that
    // `node server.js` keeps working on a machine with no key material.
    assert.strictEqual(
      cfg.tls.enabled,
      false,
      'TLS must default to disabled; making a certificate a precondition of ' +
        'local execution would break zero-configuration startup.'
    );
  });

  it('constructs a cleartext http.Server, not an https.Server', () => {
    assert.ok(
      server instanceof http.Server,
      'With TLS disabled the exported listener must be a plain http.Server.'
    );

    assert.ok(
      !(server instanceof https.Server),
      'No TLS listener may be constructed while TLS is disabled; exactly one ' +
        'listener exists, and there is no cleartext companion to an encrypted ' +
        'one nor an encrypted companion to a cleartext one.'
    );
  });

  it('binds no port on import, proving the require.main guard holds', () => {
    // The original called `listen()` unconditionally at line 12, which is
    // exactly why in-process security testing was impossible: importing the
    // module opened a socket and concurrent suites collided on it. This single
    // assertion protects the harness of all six security suites, so if it ever
    // fails, fix `server.js` - never work around it here.
    assert.strictEqual(
      server.listening,
      false,
      'Requiring server.js must not bind a port. `listen()` is guarded by ' +
        '`require.main === module` and must stay guarded.'
    );
  });

  it('exports exactly the { app, server } handles the harness needs', () => {
    assert.ok(app !== undefined && app !== null, 'server.js must export `app`.');
    assert.ok(server !== undefined && server !== null, 'server.js must export `server`.');

    // An Express application is a callable request handler, which is what
    // lets `supertest` drive it in-process without any port at all.
    assert.strictEqual(
      typeof app,
      'function',
      'The exported app must be a callable request handler.'
    );
  });
});

/* -------------------------------------------------------------------------
 * 4.6 - the default bind, unchanged in effect.
 * ---------------------------------------------------------------------- */

describe('behaviour preservation: the default bind address', () => {
  it('still defaults to 127.0.0.1:3000', () => {
    // The literals at `server.js` lines 3-4 became configuration defaults.
    // AAP 0.8.3.2 requires the EFFECTIVE behaviour to be unchanged, which is
    // what these two assertions hold the configuration module to.
    //
    // MITIGATING FACTOR, NOT A CONTROL (AAP 0.3.3): loopback binding is one
    // configuration value away from being a public bind and confers nothing
    // on a shared or containerised host. No assertion in this file or any
    // sibling suite may treat it as protection, and no control may be
    // conditioned on it.
    assert.strictEqual(cfg.host, EXPECTED_HOST, 'The default bind host must be unchanged.');

    assert.strictEqual(
      Number(cfg.port),
      EXPECTED_PORT,
      'The default bind port must be unchanged.'
    );
  });
});
