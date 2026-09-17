'use strict';

/**
 * V-04 regression suite - cleartext-only transport; no TLS listener.
 *
 * WEAKNESSES: CWE-319 (cleartext transmission of sensitive information),
 * CWE-311 (missing encryption of sensitive data), CWE-523 (unprotected
 * transport of credentials). OWASP Top 10 2021 A02, Cryptographic Failures.
 *
 * THE PRE-FIX STATE THIS SUITE EXISTS TO PROVE GONE
 * -------------------------------------------------
 * `server.js` line 1 required only the `http` module, so cleartext was the
 * sole possible transport. The `https` and `tls` modules were never
 * referenced anywhere in the repository, which means no TLS context, no
 * cipher policy and no protocol floor existed. A TLS handshake against the
 * listener therefore failed at the protocol layer rather than being refused
 * by policy - OpenSSL `0A00010B`, "wrong version number", with curl
 * reporting HTTP code `000`.
 *
 * WHAT THE FIX MADE TESTABLE, AND WHAT IS ASSERTED HERE
 * ----------------------------------------------------
 * `server.js` is now a transport bootstrap that constructs exactly one
 * listener: `https.createServer({ key, cert, minVersion })` when TLS is
 * enabled, `http.createServer(app)` otherwise. The three transport paths
 * below map one-to-one onto the three behaviours verified on the prototype,
 * so a failure here is a real divergence from verified behaviour rather than
 * a test artefact:
 *
 *   1. TLS unset    -> a cleartext `http.Server` serves `200` with NO
 *                      certificate material present anywhere (section 4.1).
 *   2. TLS enabled   -> an `https.Server` serves `200` over HTTPS and carries
 *                      `Strict-Transport-Security` (section 4.2).
 *   3. TLS 1.1 client -> no secure session is established; a client that can
 *                      negotiate TLS 1.2 or better still connects
 *                      (section 4.3).
 *
 * Section 4.4 then asserts the secrets hygiene that opt-in HTTPS made
 * necessary: configuration carries PATHS, never key bytes.
 *
 * WHY IN-PROCESS TLS IS WHAT GETS TESTED
 * --------------------------------------
 * Terminating TLS at a reverse proxy or ingress was evaluated and rejected as
 * unavailable: there is no `Dockerfile`, no compose file, no Kubernetes
 * manifest and no ingress anywhere in this repository, so there is no proxy
 * layer to configure. An in-process, opt-in listener is the only
 * implementable form of HTTPS here, which is why this suite drives a real
 * socket rather than a proxy configuration.
 *
 * THE PORT-BINDING EXCEPTION - READ BEFORE COPYING THIS FILE
 * ----------------------------------------------------------
 * Every other suite in `test/security/` drives the exported Express
 * application in-process through `supertest` and binds NO port at all. This
 * file is the sole authorised exception, because a protocol floor cannot be
 * observed without a real TLS handshake, and `supertest` builds `http://`
 * URLs and does not drive an HTTPS listener cleanly. The exception is kept as
 * narrow as possible:
 *
 *   * every listener binds port `0` - an OS-assigned ephemeral port - on
 *     `127.0.0.1` only, so concurrent suites and sibling checkouts cannot
 *     collide. No fixed port such as 3000 is ever bound;
 *   * every listener opened is closed, on the success path in a `finally` and
 *     on any remaining path in the `after()` hook;
 *   * every client socket is destroyed, so the process exits promptly.
 *
 * The loopback bind is NOT treated as a security property by any assertion
 * below. It is a mitigating factor, not a control: it is one configuration
 * value from being a public bind and confers nothing on a shared host.
 *
 * NO KEY MATERIAL IN THE REPOSITORY
 * ---------------------------------
 * HTTPS support references key and certificate files by filesystem path via
 * `TLS_KEY_PATH` and `TLS_CERT_PATH` only, and `.gitignore` now excludes
 * `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `.env` and `.env.*`. This file
 * honours that by generating throwaway material into a fresh
 * `fs.mkdtempSync` directory under the OS temp directory - OUTSIDE the
 * repository - and deleting it in `after()`. Nothing is committed, nothing is
 * written inside the checkout, and section 4.4 asserts both facts rather than
 * trusting them.
 *
 * This generation is a test fixture and must not be read as a
 * certificate-management example: provisioning, storage, rotation and
 * distribution of real certificates is operational work outside the scope of
 * this code change.
 *
 * RUNNER CONTRACT
 * ---------------
 * CommonJS, because `package.json` declares no `type` field. Built-in
 * `node:test` with `node:assert/strict`; no third-party test framework.
 *
 * Run through the `test` script in `package.json`, which passes `node --test`
 * a QUOTED GLOB. The glob form is mandatory: the directory form
 * `node --test test/` fails on this runtime with `MODULE_NOT_FOUND`, which
 * would make a fully working security suite look broken.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

/* -------------------------------------------------------------------------
 * Constants. Every literal below is either a contract this suite defends or
 * a bound that stops a failure from hanging the run.
 * ---------------------------------------------------------------------- */

/** Repository root, two levels up from `test/security/`. */
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

/** The transport bootstrap under test. */
const SERVER_MODULE = '../../server.js';

/** The configuration module whose resolved values the bootstrap consumes. */
const CONFIG_MODULE = '../../config/security.js';

/**
 * The preserved response contract, byte for byte. Asserting the LENGTH as
 * well as the string is deliberate: a stray carriage return or a trimmed
 * newline would keep the string comparison plausible-looking while breaking
 * the 14-byte guarantee, and the encrypted path must preserve it exactly as
 * the cleartext path does.
 */
const GREETING_BODY = 'Hello, World!\n';

/** Byte length of that body. Not a magic number - it is the gate. */
const GREETING_BYTE_LENGTH = 14;

/** Successful status, unchanged from the pre-remediation listener. */
const OK_STATUS = 200;

/** Bind address. Loopback only - see the port-binding exception above. */
const LOOPBACK_ADDRESS = '127.0.0.1';

/** Ephemeral port: the OS assigns one, so nothing can collide. */
const EPHEMERAL_PORT = 0;

/** The protocol floor this service states explicitly rather than inheriting. */
const EXPECTED_TLS_MIN_VERSION = 'TLSv1.2';

/** Bound on a single request, so a stalled socket fails instead of hanging. */
const REQUEST_TIMEOUT_MS = 10000;

/** Bound on a single handshake attempt, for the same reason. */
const TLS_HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Filename shapes that would mean private key or certificate material had
 * entered the checkout. Mirrors the `.gitignore` patterns exactly.
 */
const CERTIFICATE_ARTEFACT_PATTERN = /\.(pem|key|crt|p12|pfx)$/i;

/** PEM armour. Its presence in a CONFIG VALUE means key bytes leaked in. */
const PEM_ARMOUR_MARKER = '-----BEGIN';

/** Prefix for the throwaway material directory, under the OS temp dir. */
const TEMP_DIRECTORY_PREFIX = 'sec-tls-';

/**
 * Rate-limit budget raised for this file only.
 *
 * The limiter is stage 3 of the pipeline and would otherwise be free to
 * answer `429` to a transport assertion, turning a TLS result into a
 * throttling result. Raising the budget keeps every status code below
 * attributable to the transport under test. It is set before any `require`
 * of the application, because configuration is captured at module load.
 *
 * Each `loadServer()` call also discards the limiter's in-memory store along
 * with the modules, so every loaded instance starts from an empty count
 * regardless - this is belt and braces, not the only guard.
 */
process.env.RATE_LIMIT_MAX = '1000000';

/* -------------------------------------------------------------------------
 * Throwaway TLS material, generated at module scope.
 * ---------------------------------------------------------------------- */

/**
 * Summarise why material could not be generated, WITHOUT naming a path.
 *
 * `execFileSync`'s own message embeds the full command line, temp paths
 * included. Those paths are not secret, but keeping filesystem layout out of
 * reported diagnostics matches the convention `server.js` and
 * `config/security.js` already apply to their configuration errors, so the
 * error code is preferred and the message is the last resort.
 *
 * @param {*} error Whatever was thrown.
 * @returns {string} Short, path-free description.
 */
const describeGenerationFailure = (error) => {
  if (error && error.code) {
    return String(error.code);
  }

  if (error && typeof error.status === 'number') {
    return 'openssl exited with status ' + error.status;
  }

  if (error && error.message) {
    return error.message;
  }

  return 'unknown error';
};

/**
 * Why TLS material is unavailable, or `null` when it was generated. Reported
 * in the skip reason of every test that needs it.
 *
 * @type {string|null}
 */
let tlsMaterialFailure = null;

/**
 * Generate a short-lived self-signed key/certificate pair.
 *
 * Generation happens at MODULE SCOPE and not in a `before()` hook because
 * `server.js` reads the key and certificate from disk at load time: the files
 * must already exist before the first `require` that needs them.
 *
 * Failure is NOT fatal. `openssl` was present when this suite was written
 * (OpenSSL 3.x) but a runtime without it must degrade to reported skips
 * rather than a red suite - and a module-scope throw would fail the entire
 * file, including the five tests that need no certificate at all: both
 * cleartext tests in section 4.1, the protocol-floor configuration check in
 * section 4.3, and the two configuration checks in section 4.4. The failure
 * is swallowed into a `null` flag, and every test that genuinely needs the
 * material carries a `skip` with a stated reason, because a skip that says
 * why is honest where a silent pass is not.
 *
 * @returns {{dir: string, keyPath: string, certPath: string}|null} Paths of
 *   the generated material, or `null` when it could not be generated.
 */
const generateTlsMaterial = () => {
  let directory = null;

  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));

    const keyPath = path.join(directory, 'test-tls.key');
    const certPath = path.join(directory, 'test-tls.crt');

    // A one-day, self-signed, 2048-bit RSA pair for `127.0.0.1`. The SAN is
    // supplied so the certificate is well-formed for the address it serves;
    // clients below still pass `rejectUnauthorized: false`, because this
    // suite asserts TRANSPORT behaviour and not chain validation. `stdio:
    // 'ignore'` suppresses openssl's progress output, which it writes to
    // stderr even on success.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=' + LOOPBACK_ADDRESS,
        '-addext',
        'subjectAltName=IP:' + LOOPBACK_ADDRESS,
      ],
      { stdio: 'ignore' }
    );

    // A silent failure that produced empty files would surface later as an
    // opaque OpenSSL error from `https.createServer`, so it is caught here.
    if (fs.statSync(keyPath).size === 0 || fs.statSync(certPath).size === 0) {
      throw new Error('openssl produced empty TLS material');
    }

    return { dir: directory, keyPath, certPath };
  } catch (error) {
    tlsMaterialFailure = describeGenerationFailure(error);

    // Leave nothing behind on the way out: a partially written key must not
    // outlive the attempt that created it.
    if (directory !== null) {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    return null;
  }
};

/** Generated material, or `null` when `openssl` is unavailable. */
const tlsMaterial = generateTlsMaterial();

/**
 * `node:test` skip value: `false` runs the test, a string skips it with the
 * reason shown in the runner's output. The reason names the underlying
 * failure, so a host without `openssl` reports why the encrypted transport
 * paths were not exercised instead of passing silently.
 */
const tlsSkip = tlsMaterial
  ? false
  : 'openssl unavailable - cannot generate test certificate material (' +
    tlsMaterialFailure +
    '), so the TLS-enabled transport paths cannot be exercised on this host';

/* -------------------------------------------------------------------------
 * The load-order problem, and the purge that solves it.
 * ---------------------------------------------------------------------- */

/**
 * Drop every first-party module from the require cache.
 *
 * WHY THIS IS NECESSARY, AND NOT GRATUITOUS
 * -----------------------------------------
 * `config/security.js` reads `process.env` exactly ONCE, at require time, and
 * freezes the object it exports. It offers no factory, no `load(env)` and no
 * reload API - deliberately, so security policy cannot be mutated at runtime.
 * `server.js` consumes that frozen object at load time and, when TLS is
 * enabled, reads the key and certificate from disk at load time too. So
 * configuration is CAPTURED AT MODULE LOAD: mutating `process.env` after the
 * first `require` changes nothing at all.
 *
 * This suite is the one file that needs TWO effective configurations - TLS
 * off and TLS on - where a file normally has one. Clearing the cache is the
 * mechanism `config/security.js` itself names for exactly this case ("a
 * consumer that needs different values runs in a child process with a
 * different environment or clears `require.cache`"). Without the purge, the
 * second configuration would silently be the first, and the TLS-enabled
 * assertions would be testing the cleartext listener.
 *
 * The selection is generic rather than a list of filenames, so it keeps
 * working when a module is added or renamed: everything resolved inside the
 * repository is dropped - `server.js`, `src/app.js`, every
 * `src/middleware/*.js` and `config/security.js` - while `node_modules`
 * entries are kept, because re-evaluating `express`, `helmet` and their
 * transitive tree on every load would be slow and would serve no purpose:
 * those modules read no configuration at import time.
 *
 * This file's own cache entry is preserved. It sits inside the repository and
 * would otherwise match, and while nothing here re-requires it, keeping it
 * removes any possibility of this suite being evaluated twice and registering
 * its tests twice.
 *
 * @returns {void}
 */
const purgeRepositoryModules = () => {
  for (const cachedPath of Object.keys(require.cache)) {
    if (cachedPath === __filename) {
      continue;
    }

    const isFirstParty =
      cachedPath.startsWith(REPOSITORY_ROOT + path.sep) &&
      !cachedPath.includes(path.sep + 'node_modules' + path.sep);

    if (isFirstParty) {
      delete require.cache[cachedPath];
    }
  }
};

/**
 * Load a freshly configured transport bootstrap.
 *
 * Applies the supplied environment overrides, purges the first-party module
 * cache, requires `server.js` so it re-resolves its configuration and re-reads
 * any TLS material, then restores the previous environment before returning.
 * The restore runs in a `finally`, so a fail-closed throw from
 * `config/security.js` cannot leak an override into a later test - which is
 * what makes the tests below order-independent.
 *
 * The returned `cfg` is the very object the returned `server` was built from,
 * captured while the overrides were still in place, so assertions about
 * configuration and assertions about behaviour cannot drift apart.
 *
 * The returned server is CONSTRUCTED BUT NOT LISTENING: `server.js` guards
 * its `listen()` with `require.main === module`, so requiring it opens no
 * socket. Callers that need a socket bind one themselves, on an ephemeral
 * port, through `listenOnEphemeralPort()`.
 *
 * @param {Object<string, string|undefined>} [envOverrides] Variables to set
 *   for the duration of the load. A value of `undefined` UNSETS the variable,
 *   which is how the zero-configuration default is exercised faithfully -
 *   setting `TLS_ENABLED` to an empty string would not be the same test.
 * @returns {{app: Function, server: (http.Server|https.Server), cfg: Object}}
 *   The exported application and listener, plus the resolved configuration.
 */
const loadServer = (envOverrides = {}) => {
  const overriddenKeys = Object.keys(envOverrides);
  const savedValues = new Map();

  for (const key of overriddenKeys) {
    savedValues.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined
    );
  }

  const applyValue = (key, value) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  try {
    for (const key of overriddenKeys) {
      applyValue(key, envOverrides[key]);
    }

    purgeRepositoryModules();

    const { app, server } = require(SERVER_MODULE);
    const cfg = require(CONFIG_MODULE);

    return { app, server, cfg };
  } finally {
    for (const [key, value] of savedValues) {
      applyValue(key, value);
    }
  }
};

/**
 * Environment that turns the encrypted listener on, pointing at the throwaway
 * material generated above.
 *
 * Every call site has already established that `tlsMaterial` is non-null -
 * either through the `tlsSkip` gate on the test or through an explicit
 * guard - so the property reads below are safe.
 *
 * @returns {Object<string, string>} Overrides for `loadServer()`.
 */
const tlsEnabledEnvironment = () => ({
  TLS_ENABLED: 'true',
  TLS_KEY_PATH: tlsMaterial.keyPath,
  TLS_CERT_PATH: tlsMaterial.certPath,
});

/**
 * Environment that turns the encrypted listener off by UNSETTING every TLS
 * variable, reproducing a host that has never been configured for HTTPS.
 *
 * @returns {Object<string, undefined>} Overrides for `loadServer()`.
 */
const tlsDisabledEnvironment = () => ({
  TLS_ENABLED: undefined,
  TLS_KEY_PATH: undefined,
  TLS_CERT_PATH: undefined,
});

/* -------------------------------------------------------------------------
 * Socket lifecycle. Nothing opened here may outlive the run.
 * ---------------------------------------------------------------------- */

/**
 * Every listener currently bound by this suite. The `after()` hook drains it,
 * so a test that throws between `listen` and `close` cannot leave a socket
 * behind and stall the process.
 *
 * @type {Set<http.Server|https.Server>}
 */
const openListeners = new Set();

/**
 * Bind a listener to an OS-assigned port on loopback.
 *
 * @param {http.Server|https.Server} server Constructed, unbound listener.
 * @returns {Promise<number>} The port the OS assigned.
 */
const listenOnEphemeralPort = (server) =>
  new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      openListeners.add(server);

      const address = server.address();
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(EPHEMERAL_PORT, LOOPBACK_ADDRESS);
  });

/**
 * Close a listener and every connection it still holds.
 *
 * `closeAllConnections()` is called alongside `close()` because Node keeps
 * client sockets alive by default; without it a lingering keep-alive socket
 * would delay the close callback and, with it, process exit. It is safe here
 * because closing only ever happens once a test's assertions are complete.
 *
 * Idempotent and never rejects, so it is safe in a `finally` beside whatever
 * error is already propagating.
 *
 * @param {http.Server|https.Server} server Listener to close.
 * @returns {Promise<void>} Resolves once the listener is fully closed.
 */
const closeListener = (server) =>
  new Promise((resolve) => {
    openListeners.delete(server);

    if (!server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());

    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });

/* -------------------------------------------------------------------------
 * Request helpers. `supertest` is deliberately unused: it builds `http://`
 * URLs and does not drive an HTTPS listener cleanly, and the point of this
 * suite is the transport rather than the application.
 * ---------------------------------------------------------------------- */

/**
 * Issue one request and read the whole response.
 *
 * `agent: false` gives the request its own short-lived agent instead of the
 * keep-alive global one, so the socket is not held open after the response -
 * which is what keeps `closeListener()` prompt and the process exit clean.
 * A timeout destroys a stalled socket so a transport regression surfaces as a
 * failed assertion rather than a hung run.
 *
 * @param {(typeof http|typeof https)} transport `node:http` or `node:https`.
 * @param {Object} options Request options, merged over the agent setting.
 * @returns {Promise<{status: number, headers: Object, body: Buffer}>} The
 *   status, response headers and the body as raw bytes - a Buffer, because
 *   the 14-byte guarantee is a byte-level claim.
 */
const requestOverTransport = (transport, options) =>
  new Promise((resolve, reject) => {
    const request = transport.request({ ...options, agent: false }, (response) => {
      const chunks = [];

      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('request timed out after ' + REQUEST_TIMEOUT_MS + 'ms'));
    });

    request.on('error', reject);
    request.end();
  });

/**
 * `GET /` over cleartext HTTP.
 *
 * @param {number} port Port the listener is bound to.
 * @returns {Promise<{status: number, headers: Object, body: Buffer}>} Response.
 */
const getOverHttp = (port) =>
  requestOverTransport(http, {
    host: LOOPBACK_ADDRESS,
    port,
    path: '/',
    method: 'GET',
  });

/**
 * `GET /` over HTTPS.
 *
 * `rejectUnauthorized: false` is correct here and is not a weakened
 * assertion: the certificate is a self-signed fixture, so chain validation
 * would fail by construction and would tell us nothing about the transport.
 * What is being asserted is that the listener speaks TLS, serves the
 * preserved body over it, and carries HSTS. Chain trust is a deployment
 * concern with real certificates, explicitly out of scope for this change.
 *
 * @param {number} port Port the listener is bound to.
 * @returns {Promise<{status: number, headers: Object, body: Buffer}>} Response.
 */
const getOverHttps = (port) =>
  requestOverTransport(https, {
    host: LOOPBACK_ADDRESS,
    port,
    path: '/',
    method: 'GET',
    rejectUnauthorized: false,
  });

/**
 * Attempt a TLS handshake and report whether a secure session was reached.
 *
 * Every terminal outcome is collapsed into one boolean plus a human-readable
 * reason, because the refusal of an obsolete protocol version can arrive in
 * four different shapes and only one of them - `secureConnect` - is a
 * failure of the control:
 *
 *   * an `error` event, when either peer rejects the handshake;
 *   * a `close` without `secureConnect`, when the peer simply hangs up;
 *   * a synchronous throw from `tls.connect`, when the runtime refuses to
 *     build the client context at all;
 *   * the timeout, when nothing terminal happens within the bound.
 *
 * No error code or message is inspected, deliberately. The observed refusal
 * on the prototype was `error:0A0000BF ... no protocols available` with curl
 * reporting HTTP code `000`, and it originated CLIENT-side, because modern
 * OpenSSL builds will not offer TLS 1.1 at all. Asserting a particular code
 * would bind this suite to one OpenSSL build's diagnostics; what must be
 * proven is only that no session is established.
 *
 * The socket is destroyed in the settle path's `finally`, so no probe leaks a
 * descriptor regardless of which outcome fired first.
 *
 * @param {number} port Port of the HTTPS listener to probe.
 * @param {Object} versionOptions `minVersion`/`maxVersion` for the client.
 * @returns {Promise<{established: boolean, reason: string}>} Outcome.
 */
const attemptTlsSession = (port, versionOptions) =>
  new Promise((resolve) => {
    let socket = null;
    let timer = null;
    let settled = false;

    const settle = (established, reason) => {
      if (settled) {
        return;
      }
      settled = true;

      if (timer !== null) {
        clearTimeout(timer);
      }

      try {
        if (socket !== null) {
          socket.destroy();
        }
      } finally {
        resolve({ established, reason });
      }
    };

    try {
      socket = tls.connect({
        host: LOOPBACK_ADDRESS,
        port,
        rejectUnauthorized: false,
        ...versionOptions,
      });

      timer = setTimeout(
        () => settle(false, 'no terminal event within ' + TLS_HANDSHAKE_TIMEOUT_MS + 'ms'),
        TLS_HANDSHAKE_TIMEOUT_MS
      );

      socket.once('secureConnect', () => {
        settle(true, 'secure session negotiated as ' + socket.getProtocol());
      });
      socket.once('error', (error) => {
        settle(false, 'error event (' + (error.code || error.message) + ')');
      });
      socket.once('close', () => {
        settle(false, 'socket closed without a secure session');
      });
    } catch (error) {
      // A synchronous throw is a refusal too - the runtime declined to build
      // a client context for the requested protocol version.
      settle(false, 'synchronous throw (' + (error.code || error.message) + ')');
    }
  });

/**
 * Whether `child` resolves to a location inside `parent`.
 *
 * Used to prove the throwaway key material is NOT inside the checkout.
 * Computed with `path.relative` rather than string prefixing, so a sibling
 * directory whose name merely begins with the repository's name cannot be
 * mistaken for a child.
 *
 * @param {string} parent Candidate containing directory.
 * @param {string} child Path to test.
 * @returns {boolean} `true` when `child` is strictly inside `parent`.
 */
const isInside = (parent, child) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));

  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Build the expected `Strict-Transport-Security` value from configuration
 * rather than restating it, so the assertion tracks the single source of
 * truth instead of duplicating it.
 *
 * @param {Object} cfg Resolved security configuration.
 * @returns {string} Expected header value.
 */
const expectedHstsHeader = (cfg) =>
  'max-age=' + cfg.hsts.maxAge + (cfg.hsts.includeSubDomains ? '; includeSubDomains' : '');

/* =========================================================================
 * 4.1  TLS disabled - the preserved zero-configuration default.
 *
 * `node server.js` must still start with NO environment variables and NO
 * certificate material anywhere on the machine, because HTTPS is opt-in and
 * a certificate may never become a precondition of local execution. That
 * cuts both ways: a suite that required certificates to be present in order
 * to pass would itself violate the requirement, which is why every
 * assertion in this group runs unconditionally and none is gated on
 * `tlsSkip`.
 * ====================================================================== */

describe('V-04 transport - TLS disabled is the preserved default', () => {
  it('constructs a cleartext http.Server and binds no socket on import', () => {
    const { app, server, cfg } = loadServer(tlsDisabledEnvironment());

    assert.equal(
      cfg.tls.enabled,
      false,
      'TLS must default to OFF when TLS_ENABLED is unset, so the service starts with no configuration'
    );

    assert.ok(
      server instanceof http.Server,
      'with TLS off the exported listener must be a cleartext http.Server'
    );

    // `https.Server` extends `tls.Server`, not `http.Server`, so this is a
    // genuinely independent check rather than the negation of the one above.
    assert.equal(
      server instanceof https.Server,
      false,
      'with TLS off the exported listener must not be an https.Server'
    );

    assert.equal(
      server.listening,
      false,
      'requiring server.js must open no socket - listen() is guarded by require.main === module, ' +
        'which is what makes in-process security testing possible'
    );

    assert.equal(
      typeof app,
      'function',
      'server.js must export the Express application alongside the listener'
    );
  });

  it('serves GET / over plain HTTP with the byte-identical 14-byte body', async () => {
    const { server } = loadServer(tlsDisabledEnvironment());

    try {
      const port = await listenOnEphemeralPort(server);
      const response = await getOverHttp(port);

      assert.equal(response.status, OK_STATUS, 'GET / must still answer 200 over cleartext');

      assert.equal(
        response.body.length,
        GREETING_BYTE_LENGTH,
        'the response body must remain exactly 14 bytes - hardening may not alter the contract'
      );

      assert.equal(
        response.body.toString('utf8'),
        GREETING_BODY,
        'the response body must remain byte-identical to the pre-remediation listener'
      );
    } finally {
      await closeListener(server);
    }
  });
});

/* =========================================================================
 * 4.2  TLS enabled - HTTPS serves, and HSTS rides along.
 * ====================================================================== */

describe('V-04 transport - TLS enabled serves HTTPS', () => {
  it('constructs an https.Server when TLS_ENABLED is on', { skip: tlsSkip }, () => {
    const { server, cfg } = loadServer(tlsEnabledEnvironment());

    assert.equal(cfg.tls.enabled, true, 'TLS_ENABLED=true must resolve to an enabled TLS policy');

    assert.ok(
      server instanceof https.Server,
      'with TLS on the exported listener must be an https.Server - this is the whole of V-04: ' +
        'before the fix, https was never even required'
    );

    assert.equal(
      server.listening,
      false,
      'the TLS listener must also stay unbound on import'
    );
  });

  it(
    'serves GET / over HTTPS with the 14-byte body and HSTS',
    { skip: tlsSkip },
    async () => {
      const { server, cfg } = loadServer(tlsEnabledEnvironment());

      try {
        const port = await listenOnEphemeralPort(server);
        const response = await getOverHttps(port);

        assert.equal(response.status, OK_STATUS, 'GET / must answer 200 over HTTPS');

        assert.equal(
          response.body.length,
          GREETING_BYTE_LENGTH,
          'the encrypted path must preserve the 14-byte body exactly as the cleartext path does'
        );

        assert.equal(
          response.body.toString('utf8'),
          GREETING_BODY,
          'the encrypted path must serve the byte-identical body'
        );

        // HSTS is emitted UNCONDITIONALLY by the header stage - inert over
        // plain HTTP, because browsers honour it only over HTTPS, and
        // effective the instant TLS is switched on. That is deliberate: it
        // removes the class of bug where the header is forgotten at exactly
        // the moment it starts to matter. There is deliberately NO assertion
        // anywhere in this file expecting the header to be absent when TLS
        // is off; writing one would entrench the bug this design avoids.
        assert.equal(
          response.headers['strict-transport-security'],
          expectedHstsHeader(cfg),
          'the HTTPS response must carry Strict-Transport-Security built from the configured ' +
            'max-age and includeSubDomains'
        );
      } finally {
        await closeListener(server);
      }
    }
  );
});

/* =========================================================================
 * 4.3  The TLSv1.2 floor - enforced, not advisory.
 * ====================================================================== */

describe('V-04 transport - the TLSv1.2 protocol floor', () => {
  it('states the floor in configuration, where no environment variable can weaken it', () => {
    // Runs unconditionally: the floor is a configuration fact and needs no
    // certificate to observe. Node's own default already happens to be
    // TLSv1.2, which is PRECISELY why the explicit, asserted floor matters -
    // it is the guard against someone later dropping the `minVersion` option
    // on the grounds that "Node defaults to 1.2 anyway", which would make the
    // service's cryptographic posture a property of whichever runtime is
    // installed rather than of this code (OWASP ASVS v4 V14).
    const { cfg } = loadServer(tlsDisabledEnvironment());

    assert.equal(
      cfg.tls.minVersion,
      EXPECTED_TLS_MIN_VERSION,
      'config/security.js is the single source of truth for the protocol floor and must state TLSv1.2'
    );

    // The floor is hard-coded and has no variable under any name. Proving
    // non-overridability directly is worth more than trusting the comment
    // that says so: a plausibly named variable must have no effect.
    const weakened = loadServer({
      ...tlsDisabledEnvironment(),
      TLS_MIN_VERSION: 'TLSv1',
      TLS_MIN_PROTOCOL: 'TLSv1.1',
    });

    assert.equal(
      weakened.cfg.tls.minVersion,
      EXPECTED_TLS_MIN_VERSION,
      'the protocol floor must not be weakenable through the environment (OWASP A02)'
    );
  });

  it('refuses a TLS 1.1-only client', { skip: tlsSkip }, async () => {
    const { server } = loadServer(tlsEnabledEnvironment());

    try {
      const port = await listenOnEphemeralPort(server);
      const outcome = await attemptTlsSession(port, {
        minVersion: 'TLSv1.1',
        maxVersion: 'TLSv1.1',
      });

      assert.equal(
        outcome.established,
        false,
        'a TLS 1.1-only client must not establish a secure session against the listener; ' +
          'observed outcome: ' +
          outcome.reason
      );
    } finally {
      await closeListener(server);
    }
  });

  it(
    'still admits a client that negotiates TLS 1.2 or better (positive control)',
    { skip: tlsSkip },
    async () => {
      // Without this control the negative assertion above cannot distinguish
      // "the floor is enforced" from "the listener is simply broken".
      const { server } = loadServer(tlsEnabledEnvironment());

      try {
        const port = await listenOnEphemeralPort(server);
        const outcome = await attemptTlsSession(port, {
          minVersion: EXPECTED_TLS_MIN_VERSION,
        });

        assert.equal(
          outcome.established,
          true,
          'a client negotiating TLSv1.2 or better must connect successfully; observed outcome: ' +
            outcome.reason
        );
      } finally {
        await closeListener(server);
      }
    }
  );
});

/* =========================================================================
 * 4.4  Secrets hygiene - the constraint opt-in HTTPS introduced.
 *
 * HTTPS put private key material into the operational picture for the first
 * time. These assertions keep it out of the repository and out of
 * configuration values, so the `.gitignore` patterns stay PURELY PREVENTIVE
 * rather than becoming a cleanup of something already committed.
 * ====================================================================== */

describe('V-04 secrets hygiene - key material stays outside the repository', () => {
  it('carries certificate PATHS in configuration, never inline PEM material', () => {
    const disabled = loadServer(tlsDisabledEnvironment());

    assert.equal(
      disabled.cfg.tls.keyPath,
      null,
      'an unconfigured TLS key path must be null, not a default path inside the repository'
    );

    assert.equal(
      disabled.cfg.tls.certPath,
      null,
      'an unconfigured TLS certificate path must be null'
    );

    if (!tlsMaterial) {
      return;
    }

    const enabled = loadServer(tlsEnabledEnvironment());

    for (const [name, value] of [
      ['tls.keyPath', enabled.cfg.tls.keyPath],
      ['tls.certPath', enabled.cfg.tls.certPath],
    ]) {
      assert.equal(
        typeof value,
        'string',
        name + ' must be a filesystem path supplied by the environment'
      );

      // PEM armour in a configuration value would mean key BYTES had entered
      // configuration instead of a reference to them - the exact failure the
      // path-only rule exists to prevent.
      assert.equal(
        value.includes(PEM_ARMOUR_MARKER),
        false,
        name + ' must be a path, never inline PEM material'
      );
    }
  });

  it(
    'generates its throwaway material under the OS temp directory, outside the checkout',
    { skip: tlsSkip },
    () => {
      const resolvedDir = fs.realpathSync(tlsMaterial.dir);
      const resolvedTmp = fs.realpathSync(os.tmpdir());

      assert.ok(
        isInside(resolvedTmp, resolvedDir),
        'test TLS material must be generated under the OS temp directory, not anywhere else'
      );

      assert.equal(
        isInside(REPOSITORY_ROOT, resolvedDir),
        false,
        'test TLS material must never be written inside the repository, where it could be committed'
      );

      for (const materialPath of [tlsMaterial.keyPath, tlsMaterial.certPath]) {
        assert.equal(
          isInside(REPOSITORY_ROOT, materialPath),
          false,
          'no generated key or certificate file may resolve inside the repository: ' + materialPath
        );
      }
    }
  );

  it('leaves no certificate or key artefact in the repository root', () => {
    const artefacts = fs
      .readdirSync(REPOSITORY_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CERTIFICATE_ARTEFACT_PATTERN.test(entry.name))
      .map((entry) => entry.name);

    assert.deepEqual(
      artefacts,
      [],
      'the repository root must contain no *.pem, *.key, *.crt, *.p12 or *.pfx file; the ' +
        '.gitignore patterns are preventive and must stay that way. Found: ' +
        artefacts.join(', ')
    );
  });
});

/* =========================================================================
 * Teardown. Runs after every test in this file, including after a failure.
 * ====================================================================== */

after(async () => {
  // Drain anything a throwing test left bound. Without this a single failed
  // assertion between `listen` and `close` would keep the event loop alive
  // and stall the runner.
  for (const server of [...openListeners]) {
    await closeListener(server);
  }

  assert.equal(openListeners.size, 0, 'every listener this suite opened must be closed');

  if (tlsMaterial) {
    fs.rmSync(tlsMaterial.dir, { recursive: true, force: true });

    assert.equal(
      fs.existsSync(tlsMaterial.dir),
      false,
      'the throwaway TLS material directory must be removed - private key bytes must not outlive ' +
        'the test run that created them'
    );
  }
});
