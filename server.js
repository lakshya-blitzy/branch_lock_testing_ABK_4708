/**
 * @fileoverview Minimal Node.js HTTP server that answers every request with a
 * plain-text "Hello, World!" message. Implemented entirely with the Node.js
 * core `http` module and zero third-party dependencies.
 *
 * Run with: `node server.js` (there is no `npm start` script). The server
 * listens on http://127.0.0.1:3000/ and returns HTTP 200 with
 * `Content-Type: text/plain` and body `Hello, World!\n` for ANY HTTP method
 * and ANY URL path.
 *
 * @module server
 * @author hxu
 * @license MIT
 */

/**
 * Node.js core HTTP module used to create the server.
 * @see https://nodejs.org/api/http.html
 */
const http = require('http');

/**
 * Loopback host the server binds to. Because 127.0.0.1 is the loopback
 * address, the server is only reachable from the local machine.
 * @const {string}
 */
const hostname = '127.0.0.1';

/**
 * TCP port 3000 that the server listens on.
 * @const {number}
 */
const port = 3000;

/**
 * Request-handler callback invoked for every incoming connection. It ignores
 * the request entirely and responds identically to ANY HTTP method and ANY URL
 * path: it sets the status code to 200, sets the `Content-Type` header to
 * `text/plain`, and ends the response with the body `Hello, World!\n`.
 *
 * @callback requestHandler
 * @param {http.IncomingMessage} req - The incoming HTTP request (ignored).
 * @param {http.ServerResponse} res - The outgoing HTTP response; ended with
 *   status 200, `Content-Type: text/plain`, and body `Hello, World!\n`.
 * @returns {void}
 */

/**
 * The HTTP server instance, created via `http.createServer` with the
 * {@link requestHandler} callback defined above.
 *
 * @const {http.Server}
 */
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Startup (readiness) callback for `server.listen`. Invoked once, with no
 * arguments, after the server has bound to the configured host and port and is
 * ready to accept connections. It logs the running URL
 * ("Server running at http://127.0.0.1:3000/") to the console.
 *
 * @callback listenCallback
 * @returns {void}
 */

// Begin listening on the configured port (3000) and hostname (127.0.0.1); the
// listenCallback above runs once the server is ready to accept connections.
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
