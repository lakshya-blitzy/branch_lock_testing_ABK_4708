/**
 * @fileoverview Minimal, zero-dependency Node.js HTTP server built on the
 * Node.js built-in `http` module. Every ordinary HTTP request (delivered
 * through Node's `request` event) receives an identical `HTTP 200` response
 * with a `Content-Type: text/plain` header and the body `"Hello, World!\n"`;
 * the request handler never inspects the request. The server binds to the
 * loopback interface only (127.0.0.1), so it is reachable exclusively from the
 * local host. See the request-handler doclet below for the full response
 * behavior, including how Node handles the HEAD and CONNECT methods, and the
 * listen call for the loopback/port binding.
 *
 * @module server
 * @author hxu (Source: package.json:L9)
 * @license MIT (Source: package.json:L10)
 * @see {@link https://nodejs.org/api/http.html|Node.js http module}
 */
const http = require('http');

/**
 * Loopback network interface the server binds to.
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on.
 * @constant {number}
 */
const port = 3000;

/**
 * Request handler for the HTTP server. For every ordinary request delivered
 * through Node's `request` event, it responds identically and does not inspect
 * `req` (the incoming request is effectively ignored): it sets the status code
 * to 200, sets the `Content-Type: text/plain` header, and ends the response
 * with the body `"Hello, World!\n"`.
 *
 * Protocol notes (handled by Node's transport layer, not by any logic in this
 * file): for a HEAD request Node preserves this application-set status code and
 * `Content-Type` header but suppresses the response body and omits the
 * body-framing `Content-Length` header, per the HTTP specification; a CONNECT
 * request never reaches this callback because no `'connect'` listener is
 * registered, so the client receives an empty reply.
 *
 * @callback requestHandler
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
 *
 * @callback listenCallback
 * @returns {void}
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
