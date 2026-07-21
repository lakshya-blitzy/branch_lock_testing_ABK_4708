/**
 * @fileoverview Minimal, zero-dependency Node.js HTTP server built on the
 * Node.js built-in `http` module. For every request delivered through Node's
 * normal `request` event (for example GET, POST, PUT, DELETE, or PATCH on any
 * request path), the server responds identically with HTTP 200, a
 * `Content-Type: text/plain` header, and the body `"Hello, World!\n"`. Two
 * protocol-level exceptions are handled by Node itself, not by any routing
 * logic in this file: for a HEAD request Node returns the same 200 status and
 * headers but suppresses the response body (per the HTTP specification), and a
 * CONNECT request is not delivered to this handler because no `'connect'`
 * listener is registered, so the client receives an empty reply. The server
 * binds to the loopback interface only (127.0.0.1), so it is reachable
 * exclusively from the local host. Response behavior is implemented by the
 * request handler (Source: server.js:L52-L56); the loopback and port
 * binding are established by the listen call (Source: server.js:L67-L69).
 *
 * @module server
 * @author hxu (Source: package.json:L9)
 * @license MIT (Source: package.json:L10)
 * @see {@link https://nodejs.org/api/http.html|Node.js http module}
 */
const http = require('http');

/**
 * Loopback network interface the server binds to.
 * Source: server.js:L29
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on.
 * Source: server.js:L35
 * @constant {number}
 */
const port = 3000;

/**
 * Request handler for the HTTP server. For every request delivered through
 * Node's normal `request` event, it handles the request identically and does
 * not inspect `req` (the incoming request is effectively ignored): it sets the
 * status code to 200, sets the `Content-Type: text/plain` header, and ends the
 * response with the body `"Hello, World!\n"`. Protocol note: for a HEAD
 * request the same status and headers are produced but Node suppresses the
 * body, and a CONNECT request never reaches this callback because no
 * `'connect'` listener is registered.
 * Source: server.js:L52-L56
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
 * Source: server.js:L67-L69
 *
 * @returns {void}
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
