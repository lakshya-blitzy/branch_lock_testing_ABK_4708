/**
 * @file server.js
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
 * TCP port the server listens on.
 * @const {number}
 */
const port = 3000;

/**
 * The HTTP server instance. Its request-handler callback responds identically
 * to every request, ignoring the HTTP method and URL path: it sets the status
 * to 200, the `Content-Type` header to `text/plain`, and ends the response
 * with the body `Hello, World!\n`.
 *
 * @const {http.Server}
 * @param {http.IncomingMessage} req - The incoming HTTP request (ignored).
 * @param {http.ServerResponse} res - The outgoing HTTP response; ended with
 *   status 200, `Content-Type: text/plain`, and body `Hello, World!\n`.
 */
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Start listening for connections on the configured port and hostname. The
 * listen callback runs once the server is ready and logs the running URL
 * ("Server running at http://127.0.0.1:3000/") to the console.
 *
 * @param {number} port - TCP port to listen on (3000).
 * @param {string} hostname - Host interface to bind (127.0.0.1).
 * @param {function(): void} callback - Startup callback; logs the running URL.
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
