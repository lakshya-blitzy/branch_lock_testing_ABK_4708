/**
 * @fileoverview Minimal single-response HTTP server built on the Node.js core
 * `http` module. Listens on a fixed loopback host and port. For every normal
 * inbound request (each `request` event, regardless of HTTP method or URL
 * path) it sends a `200 OK` plain-text `Hello, World!` response. Self-starting:
 * running this file with `node server.js` immediately binds the socket and
 * begins listening.
 *
 * Scope note: the description above covers the application-level `request`-event
 * path only. Transport- and parser-level cases are handled by Node's HTTP layer
 * and behave differently — HEAD replies carry the same headers but no body,
 * CONNECT is not delivered as a `request` event, malformed or oversized
 * requests receive parser-generated 400/431 responses, and HTTP/1.0 clients get
 * connection-close framing without a `Content-Length`. See the API
 * documentation in README.md.
 *
 * @module server
 */

// Node.js core HTTP module — the only dependency (no external npm packages).
const http = require('http');

/**
 * Hostname/interface the server binds to. `127.0.0.1` is loopback-only
 * (local machine); use `'0.0.0.0'` to accept connections on all interfaces
 * (see the Deployment section of README.md).
 *
 * Security warning: switching to `'0.0.0.0'` is not a security control. It
 * exposes this unauthenticated, plain-HTTP demo — which has no TLS, no
 * authentication/authorization, no rate limiting, and no security headers — on
 * every network interface. Before any non-local exposure, restrict access with
 * a firewall or private networking and terminate TLS plus enforce
 * authentication/authorization at a trusted reverse proxy.
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on (hardcoded; no environment-variable override).
 * @constant {number}
 */
const port = 3000;

/**
 * Request handler for the HTTP server: the callback invoked once per normal
 * `request` event. For each such request it sends one fixed response — status
 * `200`, `Content-Type: text/plain`, body `Hello, World!\n` — and never
 * inspects the request, so the HTTP method and URL path are ignored. See the
 * request/response sequence diagram and the protocol-behavior notes in
 * README.md.
 *
 * This callback governs only the application-level `request`-event path. Node's
 * transport/parser layer handles other cases before or around it: HEAD
 * responses carry these headers but no body; CONNECT is emitted as a separate
 * event and never reaches this handler; malformed or oversized requests are
 * answered with parser-generated 400/431 responses; and HTTP/1.0 clients
 * receive connection-close framing without a `Content-Length` header.
 *
 * @callback RequestHandler
 * @param {http.IncomingMessage} req - The incoming request (ignored).
 * @param {http.ServerResponse} res - The response used to send output.
 * @returns {void}
 */

/**
 * The HTTP server instance, created with a single inline request handler
 * (see {@link RequestHandler}). The variable itself holds the server object,
 * not the handler, so it is typed as the server rather than the callback.
 *
 * @type {http.Server}
 */
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Startup callback invoked once the server is listening. Logs the listening
 * URL to stdout. This is the callback argument passed to {@link server.listen}
 * below; only this callback returns void (the `listen` call itself does not).
 *
 * @callback StartupCallback
 * @returns {void}
 */

/**
 * Starts the server by binding it to the configured port and loopback
 * hostname, then runs the startup callback that logs the listening URL.
 * This call is what makes the module self-starting.
 *
 * @param {number} port - The TCP port to listen on.
 * @param {string} hostname - The loopback interface to bind to.
 * @param {StartupCallback} callback - Startup callback invoked once the
 *   server is listening; logs the server URL to stdout.
 * @returns {http.Server} The same server instance; Node's `listen` returns the
 *   server to allow method chaining (the void return belongs to the callback).
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
