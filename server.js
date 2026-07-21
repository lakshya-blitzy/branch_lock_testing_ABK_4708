// Minimal Node.js HTTP service, now backed by the Express web framework.
// Migrated from the native `http` module to Express to enable declarative
// routing while preserving the original single-file, CommonJS convention.
const express = require('express');

// Network binding retained exactly as the original native-http server.
const hostname = '127.0.0.1';
const port = 3000;

// Express application instance replaces the former `http.createServer(...)`.
const app = express();

// Security hardening: do not advertise the framework in responses. By default
// Express sets `X-Powered-By: Express` on every response; `app.disable(...)`
// removes that header from all responses (both success and error) without
// altering any route behavior, status, body, or content type.
app.disable('x-powered-by');

// Root greeting endpoint - preserved for backward compatibility.
// Responds 200 with `Content-Type: text/plain` and the exact original body
// `Hello, World!\n` (including the trailing newline). `res.type('text/plain')`
// is set before `res.send(...)` so Express does not default the response to
// `text/html`, keeping byte-for-byte parity with the previous behavior.
// `X-Content-Type-Options: nosniff` is set so the success response carries the
// same MIME-sniffing protection Express already applies to its 404 response;
// this only adds a header and does not change the status, body, or media type.
app.get('/', (req, res) => {
  res.set('X-Content-Type-Options', 'nosniff').type('text/plain').send('Hello, World!\n');
});

// Additional greeting endpoint - returns the exact body `Good evening`
// (no trailing newline) as plain text for consistency with the root route.
// Carries the same `X-Content-Type-Options: nosniff` protection as the root
// route; this only adds a header and does not change the status, body, or type.
app.get('/good-evening', (req, res) => {
  res.set('X-Content-Type-Options', 'nosniff').type('text/plain').send('Good evening');
});

// Start listening on the same host/port as before and emit the unchanged
// startup log line so runtime behavior and observability are preserved.
//
// Express 5's `app.listen` registers this callback as BOTH the server's
// `'listening'` handler and its `'error'` handler (via `server.once('error', done)`
// in `express/lib/application.js`). On a successful bind the callback is invoked
// with no argument; on a failed bind - e.g. `EADDRINUSE` when the port is already
// in use - it is invoked with the error. We therefore inspect that argument so a
// bind failure fails loudly (logs the error to stderr and exits non-zero) instead
// of printing a false "Server running" line and exiting 0. This restores the
// fail-fast behavior of the original native-`http` server and keeps the startup
// log honest for process supervisors and operators.
app.listen(port, hostname, (err) => {
  if (err) {
    // Fail loudly on a bind error (e.g. `EADDRINUSE`) but keep the log concise:
    // emit only safe, structured fields (error code plus the affected
    // address:port) rather than the full Error object, so no internal Node
    // stack frames are written to stderr. Exit non-zero so process supervisors
    // and operators reliably detect the failed start.
    const where = err.address != null && err.port != null
      ? ` ${err.address}:${err.port}`
      : '';
    console.error(`Failed to start server: ${err.code || err.message}${where}`);
    process.exit(1);
  }
  console.log(`Server running at http://${hostname}:${port}/`);
});
