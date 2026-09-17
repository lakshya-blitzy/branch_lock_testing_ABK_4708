'use strict';

/**
 * Transport bootstrap - the only file in this service that owns a socket.
 *
 * WHAT THIS FILE REPLACES
 * -----------------------
 * This was a 14-line raw `http` listener and the entirety of the service's
 * network surface:
 *
 *     const http = require('http');
 *     const hostname = '127.0.0.1';
 *     const port = 3000;
 *     const server = http.createServer((req, res) => {
 *       res.statusCode = 200;
 *       res.setHeader('Content-Type', 'text/plain');
 *       res.end('Hello, World!\n');
 *     });
 *     server.listen(port, hostname, () => { ... });
 *
 * Six defects lived in those lines. Line 1 required only `http`, so cleartext
 * was the sole possible transport and a TLS handshake failed at the protocol
 * layer (V-04, CWE-319). Lines 3-4 hard-coded the bind address and port. The
 * handler never read `req` - no method, path, header or body was ever
 * inspected - so `TRACE /`, `DELETE /../../etc/passwd` and a 100,000-byte
 * `PUT` all returned `200` (V-02, V-07). Its single `Content-Type` header
 * meant no defensive header existed at all (V-01), and nothing counted
 * requests per client (V-03) or evaluated an `Origin` (V-06). `listen()` ran
 * unconditionally at import time, so the module could not be required for
 * testing without binding a port, and it exported nothing.
 *
 * SEPARATION OF CONCERNS - THE POINT OF THIS REWRITE
 * --------------------------------------------------
 * This file now contains TRANSPORT CONCERNS ONLY: which listener to build,
 * what protocol floor to enforce, where to bind, and when to bind. It holds
 * no route, no response header, no status code, no method check and no body
 * handling - every one of those belongs to the Express pipeline in
 * `./src/app` and the middleware under `./src/middleware`. That boundary is
 * what makes each of the six controls a discrete, independently testable
 * stage rather than another branch of one inline callback.
 *
 * Correspondingly, `./src/app` contains no `http`, no `https`, no `listen`,
 * no host and no port. Neither file may acquire the other's concern.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Resolves host, port and TLS settings from `./config/security` - the
 *      single source of truth. No `process.env` read happens here (OWASP
 *      ASVS v4, V14 Configuration), and no security literal is hard-coded
 *      except the protocol-floor allow-list that guards the config value.
 *   2. Builds the Express application from the `./src/app` factory.
 *   3. Constructs ONE listener: `https` with an explicit `TLSv1.2` floor when
 *      TLS is enabled, `http` otherwise (V-04).
 *   4. Binds the socket ONLY when executed directly (`require.main ===
 *      module`), so requiring this module for in-process testing is free of
 *      side effects.
 *   5. Exports `{ app, server }`.
 *
 * PRESERVED BEHAVIOUR - a gate, not an aspiration
 * -----------------------------------------------
 *   * `GET /` still answers `200`, `text/plain`, body exactly 14 bytes
 *     `Hello, World!\n`. The body is produced by `./src/app`; this file must
 *     not touch it. `test/security/behavior-preservation.test.js` enforces
 *     it mechanically.
 *   * `node server.js` still starts with NO environment variables and NO
 *     certificate material anywhere on the machine. HTTPS is opt-in, so a
 *     certificate is never a precondition of local execution.
 *   * The default bind is still `127.0.0.1:3000`; the literals moved into
 *     configuration, the effective behaviour did not move.
 *
 * SECURITY NOTES THAT BIND THIS FILE
 * ----------------------------------
 *   * OWASP Top 10 2021 A02, Cryptographic Failures: the protocol floor is
 *     passed EXPLICITLY to `https.createServer` rather than inherited from a
 *     runtime default, so obsolete protocol versions are actively refused at
 *     the handshake. A TLS 1.1 client is rejected, not downgraded.
 *   * Secrets hygiene: key and certificate material is referenced BY
 *     FILESYSTEM PATH from the environment only. Nothing is inlined, no path
 *     defaults into the repository, and no certificate is generated here.
 *     The material is read with `fs.readFileSync` on the configured paths and
 *     from nowhere else.
 *   * Fail closed: when TLS is enabled but a path is missing, unreadable or
 *     empty, startup is REFUSED with an explanatory error. Falling back to
 *     cleartext would serve unencrypted traffic to a deployment that
 *     explicitly asked for encryption - failing open is prohibited.
 *   * No reliance on incidental safety: the `127.0.0.1` default is a
 *     MITIGATING FACTOR, NOT A CONTROL. It is one configuration value from
 *     being a public bind and confers nothing on a shared or containerised
 *     host. No decision in this file is conditioned on the bind address, and
 *     none may become so.
 *   * `Strict-Transport-Security` is emitted unconditionally by the header
 *     stage in `./src/app`, including over plain HTTP where browsers ignore
 *     it. That is deliberate and must not be made conditional here: it
 *     removes the class of bug where the header is forgotten at the moment
 *     TLS is switched on.
 *
 * WHY TLS TERMINATES IN-PROCESS
 * -----------------------------
 * There is no `Dockerfile`, no compose file, no Kubernetes manifest and no
 * ingress anywhere in this repository, so there is no proxy layer to
 * delegate encryption to. An in-process, opt-in listener is the only
 * implementable form of HTTPS here. Where a real deployment does front the
 * service, leave `TLS_ENABLED` off: every other control remains correct.
 *
 * MODULE CONTRACT
 * ---------------
 * CommonJS, because `package.json` declares no `type` field. The export is
 * exactly `{ app, server }`:
 *
 *   app     the Express application, for in-process tests driven through
 *           `supertest` - which binds no port at all.
 *   server  the constructed but (on import) UNBOUND listener, for tests that
 *           need a real socket and call `server.listen(0)` themselves.
 *
 * Requiring this module builds an application and a server object but opens
 * no socket and writes nothing to stdout. It DOES throw when TLS is enabled
 * and misconfigured, which is the fail-closed gate rather than a side effect.
 *
 * `runner.js` - reference-only, and deliberately NOT modified - does
 * `require('./server')` at line 15 and calls the result as a factory at line
 * 36. That call already threw before this change, because this file exported
 * nothing; the export added here moves the file toward that contract at no
 * risk. Repairing `runner.js` is a pre-existing defect outside this work, and
 * this file's export shape is not contorted to suit it.
 *
 * FINDINGS: closes V-04 (cleartext-only transport, CWE-319); enables the
 * elimination of V-01, V-02, V-03, V-06 and V-07 by routing every request
 * through the hardened pipeline.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');

const cfg = require('./config/security');
const createApp = require('./src/app');

/* -------------------------------------------------------------------------
 * Transport constants.
 * ---------------------------------------------------------------------- */

/**
 * Protocol floors this listener will accept from configuration.
 *
 * `config/security.js` hard-codes `tls.minVersion` to `TLSv1.2` and exposes
 * no environment variable for it, precisely so the floor cannot be weakened
 * by configuration. This allow-list is the fail-closed second half of that
 * guarantee: if the configured floor is ever anything other than a currently
 * acceptable version, this file refuses to construct a listener rather than
 * serving traffic over an obsolete protocol. TLS 1.0 and 1.1 are deprecated
 * (RFC 8996) and are absent by design.
 */
const ACCEPTED_TLS_MIN_VERSIONS = Object.freeze(['TLSv1.2', 'TLSv1.3']);

/** URL scheme of an encrypted listener, used only in the startup log. */
const TLS_SCHEME = 'https';

/** URL scheme of a cleartext listener, used only in the startup log. */
const CLEARTEXT_SCHEME = 'http';

/* -------------------------------------------------------------------------
 * TLS material loading. Fail loudly, never fall back to cleartext.
 * ---------------------------------------------------------------------- */

/**
 * Read one PEM artefact from the path a TLS environment variable supplied.
 *
 * Called ONLY when TLS is enabled. Reading key material unconditionally would
 * make a certificate a precondition of zero-configuration startup, which is
 * forbidden - so this function is never reached on the cleartext path.
 *
 * Failure is fatal by design. There is no retry, no default and no cleartext
 * fallback: a deployment that set `TLS_ENABLED` asked for encryption, and
 * quietly serving it plaintext instead would be failing open.
 *
 * The thrown message names the ENVIRONMENT VARIABLE and the underlying error
 * code but never the resolved path, matching the convention `config/
 * security.js` already applies to its own configuration errors. That keeps
 * filesystem layout out of logs and out of any diagnostic that might be
 * surfaced, while still telling an operator exactly which variable to fix.
 * The original error is attached as `cause`, so the full detail remains
 * available to whoever is entitled to the process's own stderr.
 *
 * @param {string} variableName Environment variable that supplied the path,
 *   used verbatim in the error message.
 * @param {string} filePath Filesystem path to read, as resolved by the
 *   configuration module.
 * @param {string} description Human-readable artefact name for the message.
 * @returns {Buffer} The file's contents, guaranteed non-empty.
 * @throws {Error} When the file cannot be read, or is empty.
 */
const readTlsMaterial = (variableName, filePath, description) => {
  let material;

  try {
    material = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(
      'TLS_ENABLED is on but the TLS ' +
        description +
        ' at the path configured by ' +
        variableName +
        ' could not be read (' +
        (error?.code ? error.code : 'unknown error') +
        '). Startup is refused rather than falling back to cleartext, which' +
        ' would serve unencrypted traffic to a deployment that explicitly' +
        ' asked for HTTPS.',
      { cause: error }
    );
  }

  // An empty file is a misconfiguration that `https.createServer` would
  // report far less clearly - typically as an opaque OpenSSL error - so it is
  // caught here, where the message can name the variable at fault.
  if (material.length === 0) {
    throw new Error(
      'TLS_ENABLED is on but the TLS ' +
        description +
        ' at the path configured by ' +
        variableName +
        ' is empty. Startup is refused rather than falling back to cleartext.'
    );
  }

  return material;
};

/**
 * Construct the encrypted listener.
 *
 * `minVersion` is passed EXPLICITLY, sourced from the configuration module
 * that hard-codes it, and validated against `ACCEPTED_TLS_MIN_VERSIONS`
 * first. Relying on the runtime's default floor would make the service's
 * cryptographic posture a property of whichever Node version happened to be
 * installed; stating it makes the refusal of obsolete protocol versions a
 * property of this code. A client forced to TLS 1.1 is rejected during the
 * handshake and never reaches the application.
 *
 * No cipher suite, curve or renegotiation option is overridden: the runtime's
 * modern defaults are stronger than a hand-maintained list would stay, and
 * narrowing them here would be a control nobody revisits.
 *
 * @returns {https.Server} A TLS listener, not yet bound to any port.
 * @throws {Error} When the configured floor is unacceptable, or when the key
 *   or certificate cannot be read.
 */
const createTlsServer = () => {
  const minVersion = cfg.tls.minVersion;

  if (!ACCEPTED_TLS_MIN_VERSIONS.includes(minVersion)) {
    throw new Error(
      'Refusing to start an HTTPS listener with the TLS protocol floor ' +
        String(minVersion) +
        '. Accepted floors are ' +
        ACCEPTED_TLS_MIN_VERSIONS.join(' and ') +
        '; obsolete protocol versions must be refused at the handshake and' +
        ' cannot be re-admitted through configuration.'
    );
  }

  const key = readTlsMaterial('TLS_KEY_PATH', cfg.tls.keyPath, 'private key');
  const cert = readTlsMaterial('TLS_CERT_PATH', cfg.tls.certPath, 'certificate');

  return https.createServer({ key, cert, minVersion }, app);
};

/* -------------------------------------------------------------------------
 * Startup diagnostics.
 * ---------------------------------------------------------------------- */

/**
 * Render a bound address for the startup log.
 *
 * IPv6 literals are bracketed so the logged value is a usable URL authority
 * rather than an ambiguous string - `http://[::1]:3000/`, not
 * `http://::1:3000/`.
 *
 * @param {string} address Address as reported by `server.address()`.
 * @returns {string} URL-safe authority host component.
 */
const formatHost = (address) => (address.includes(':') ? '[' + address + ']' : address);

/**
 * The one line this file writes to stdout, preserving the original startup
 * message's usefulness with two corrections.
 *
 * The scheme reflects the ACTUAL transport instead of hard-coding `http://`,
 * which would have told an operator with TLS enabled exactly the wrong thing.
 * The authority is taken from `server.address()` when available, so a
 * configured port of `0` logs the port the OS actually assigned rather than
 * the literal `0`. Per-request logging is not done here - that is the audit
 * trail in `src/middleware/logging.js`.
 *
 * @param {http.Server|https.Server} listener The bound listener.
 * @returns {void}
 */
const logStartup = (listener) => {
  const scheme = cfg.tls.enabled ? TLS_SCHEME : CLEARTEXT_SCHEME;
  const address = listener.address();
  const host = address && typeof address === 'object' ? formatHost(address.address) : cfg.host;
  const port = address && typeof address === 'object' ? address.port : cfg.port;

  console.log(`Server running at ${scheme}://${host}:${port}/`);
};

/* -------------------------------------------------------------------------
 * Wiring.
 * ---------------------------------------------------------------------- */

/**
 * The hardened Express application. Built here and passed to whichever
 * listener is constructed below, so both transports serve the identical
 * pipeline and neither can drift from the other's security posture.
 */
const app = createApp();

/**
 * The single listener.
 *
 * Exactly one is constructed - there is no second, unhardened path, and no
 * cleartext companion listener alongside the TLS one that could be used to
 * bypass encryption. The ternary is the whole of the transport decision
 * (V-04).
 */
const server = cfg.tls.enabled ? createTlsServer() : http.createServer(app);

/* -------------------------------------------------------------------------
 * Bind, only when run directly.
 * ---------------------------------------------------------------------- */

// `require.main === module` is true only when this file is the process entry
// point. The original bound a port as an import-time side effect, which is
// precisely why in-process security testing was impossible: importing the
// module to drive it with `supertest` would have opened a socket, and
// concurrent suites would have collided on it. Guarding the bind makes the
// module importable and keeps `node server.js` behaving exactly as before.
if (require.main === module) {
  server.listen(cfg.port, cfg.host, () => {
    logStartup(server);
  });
}

/**
 * Exactly the two handles the rest of the project needs: the application for
 * in-process tests that bind no port, and the unbound listener for tests that
 * need a real socket on an ephemeral port of their own choosing.
 */
module.exports = { app, server };
