/**
 * @fileoverview Minimal single-response HTTP server built on the Node.js core
 * `http` module. Listens on a fixed loopback host and port and replies to every
 * inbound request — regardless of HTTP method or URL path — with a `200 OK`
 * plain-text `Hello, World!` response. Self-starting: running this file with
 * `node server.js` immediately binds the socket and begins listening.
 *
 * @module server
 */

// Node.js core HTTP module — the only dependency (no external npm packages).
const http = require('http');

/**
 * Hostname/interface the server binds to. `127.0.0.1` is loopback-only
 * (local machine); use `'0.0.0.0'` to accept connections on all interfaces
 * (see the Deployment section of README.md).
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on (hardcoded; no environment-variable override).
 * @constant {number}
 */
const port = 3000;

/**
 * Request handler for the HTTP server: the callback invoked once per inbound
 * request. It responds to every request with one fixed response; the request
 * is never inspected (HTTP method and URL path are ignored). See the
 * request/response sequence diagram in README.md.
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
