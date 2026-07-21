/**
 * @fileoverview Minimal, zero-dependency Node.js HTTP server built on the
 * Node.js built-in `http` module. Responds to every HTTP method and every
 * request path identically with HTTP 200, a `Content-Type: text/plain` header,
 * and the body `"Hello, World!\n"`. The server binds to the loopback interface
 * only (127.0.0.1), so it is reachable exclusively from the local host.
 *
 * @module server
 * @author hxu
 * @license MIT
 * @see {@link https://nodejs.org/api/http.html|Node.js http module}
 */
const http = require('http');

/**
 * Loopback network interface the server binds to.
 * Source: server.js:L3
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on.
 * Source: server.js:L4
 * @constant {number}
 */
const port = 3000;

/**
 * Request handler for the HTTP server. Handles every request identically and
 * does not inspect `req` (the incoming request is effectively ignored): it sets
 * the status code to 200, sets the `Content-Type: text/plain` header, and ends
 * the response with the body `"Hello, World!\n"`.
 * Source: server.js:L6-L10
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request (unused/ignored).
 * @param {http.ServerResponse} res - The outgoing HTTP response.
 * @returns {void}
 */
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Startup callback invoked once the server is bound and listening. Logs the
 * readiness URL (`Server running at http://127.0.0.1:3000/`) to stdout via
 * `console.log`. Note: no `'error'` listener is registered on the server, so a
 * bind failure such as `EADDRINUSE` (port already in use) is fatal.
 * Source: server.js:L12-L14
 *
 * @returns {void}
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
