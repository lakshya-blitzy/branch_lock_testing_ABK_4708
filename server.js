/**
 * @file server.js
 * @fileoverview Minimal Node.js HTTP server built on the Node core `http` module.
 *
 * Creates a single HTTP server that answers **every** inbound request — regardless
 * of HTTP method or URL path — with a fixed `200 OK`, `Content-Type: text/plain`
 * response whose body is `Hello, World!\n`. The server binds to the loopback
 * interface and listens at http://127.0.0.1:3000/.
 *
 * There is no request routing, parsing, or external configuration: the host and
 * port are hard-coded constants and the response contract is identical for all
 * requests. See README.md for the full walkthrough, API contract, and deployment notes.
 *
 * @author hxu
 * @license MIT
 */
const http = require('http');

/**
 * Loopback host (bind address) the server listens on. Binding to `127.0.0.1`
 * restricts reachability to the local machine only.
 * @constant {string}
 */
const hostname = '127.0.0.1';
/**
 * TCP port the server listens on.
 * @constant {number}
 */
const port = 3000;

/**
 * Request-handler callback invoked for every inbound HTTP request.
 *
 * The request contents (method, URL, headers, body) are intentionally ignored;
 * every request receives the same fixed response: status `200`, header
 * `Content-Type: text/plain`, and body `Hello, World!\n` (note the trailing newline).
 *
 * @callback requestHandler
 * @param {http.IncomingMessage} req - Inbound request object (contents ignored).
 * @param {http.ServerResponse} res - Response object used to reply to the client.
 * @returns {void}
 */
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Startup callback invoked once the server is bound and ready to accept
 * connections. Its sole side effect is logging the base URL to standard output
 * (`Server running at http://127.0.0.1:3000/`).
 *
 * @callback startupCallback
 * @returns {void}
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
