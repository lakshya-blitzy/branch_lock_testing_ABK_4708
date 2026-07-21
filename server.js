/**
 * @file server.js
 * @module server
 * @description Minimal HTTP server built exclusively on the Node.js core `http`
 * module. It binds to the loopback interface and answers every inbound request
 * with a single fixed plain-text response. This is a catch-all: there is no
 * routing, no query/body parsing, no authentication, and no TLS, and no status
 * code other than 200 is ever emitted. Every HTTP method against every URL path
 * yields an identical response of `200 OK`, `Content-Type: text/plain`, and the
 * body `Hello, World!\n` (14 bytes).
 *
 * Runtime verified on Node.js v22.23.1. Zero third-party dependencies.
 *
 * @requires http
 */

const http = require('http');

/**
 * Loopback interface address the server binds to. Restricting the bind to
 * `127.0.0.1` makes the server reachable only from the local machine.
 * @constant {string} hostname
 */
const hostname = '127.0.0.1';

/**
 * TCP port the server listens on.
 * @constant {number} port
 */
const port = 3000;

/**
 * The HTTP server instance created from the Node.js core `http` module.
 * @constant {http.Server} server
 */
const server = http.createServer(
  /**
   * Handles every inbound HTTP request with a fixed plain-text response.
   * Catch-all: the request method and URL are ignored; every request yields an
   * identical `200` `text/plain` `Hello, World!\n` response.
   * @param {http.IncomingMessage} req - Inbound request (ignored).
   * @param {http.ServerResponse} res - Outbound response.
   * @returns {void}
   */
  (req, res) => {
    res.statusCode = 200; // Always HTTP 200 OK (no routing / no error paths).
    res.setHeader('Content-Type', 'text/plain'); // Body is plain text.
    res.end('Hello, World!\n'); // Send fixed 14-byte body and end the response.
  }
);

server.listen(
  port,
  hostname,
  /**
   * Logs a startup banner once the server is listening on the configured host/port.
   * @listens http.Server#listening
   * @returns {void}
   */
  () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  }
);
