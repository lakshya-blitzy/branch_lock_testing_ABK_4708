/**
 * @file server.js
 * @module server
 * @description Minimal HTTP server built exclusively on the Node.js core `http`
 * module. It binds to the loopback interface and answers requests with a single
 * fixed plain-text response.
 *
 * The response handler is registered on the server's `request` event, so it
 * runs for every request Node delivers to that event — that is, every
 * well-formed request that uses a recognized HTTP method other than `CONNECT`,
 * regardless of URL path, query string, headers, or body. For those requests
 * the handler always emits `200 OK`, `Content-Type: text/plain`, and the body
 * `Hello, World!\n` (14 bytes). There is no routing, no query/body parsing, no
 * authentication, and no TLS.
 *
 * A few requests never reach this handler because Node's `http` layer handles
 * them first (this is standard Node behavior, not application logic):
 *   - `HEAD`: the handler runs, but HTTP requires no message body, so Node
 *     suppresses the body and omits `Content-Length` (status + headers only).
 *   - `CONNECT`: dispatched to the server's `connect` event; with no `connect`
 *     listener the socket is closed with no response.
 *   - Unknown or malformed method tokens (e.g. `BREW`, `G?T`) are rejected by
 *     the HTTP parser with `400 Bad Request` before the handler.
 *   - Oversized headers (beyond Node's default `maxHeaderSize`) are rejected
 *     with `431 Request Header Fields Too Large`.
 *   - Message framing can vary by HTTP version: HTTP/1.0 responses use close
 *     framing and carry no `Content-Length`.
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
   * Handles every request delivered to the server's `request` event with a
   * fixed plain-text response. The request method, URL, headers, and body are
   * ignored, so every such request yields an identical `200` `text/plain`
   * `Hello, World!\n` response. Requests the `http` parser rejects (unknown or
   * malformed methods, oversized headers) and `CONNECT` never reach this
   * handler; a `HEAD` request runs the handler but is sent with no body.
   * @function requestHandler
   * @memberof module:server
   * @param {http.IncomingMessage} req - Inbound request (ignored).
   * @param {http.ServerResponse} res - Outbound response.
   * @returns {void}
   */
  (req, res) => {
    res.statusCode = 200; // Handler always sets HTTP 200 (no routing / no error paths).
    res.setHeader('Content-Type', 'text/plain'); // Body is plain text.
    res.end('Hello, World!\n'); // Write the fixed 14-byte body (HTTP framing may omit it, e.g. HEAD).
  }
);

server.listen(
  port,
  hostname,
  /**
   * Logs a startup banner once the server is listening on the configured host/port.
   * @function onListening
   * @memberof module:server
   * @listens http.Server#listening
   * @returns {void}
   */
  () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  }
);
