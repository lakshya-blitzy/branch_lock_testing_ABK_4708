// Minimal Node.js HTTP service, now backed by the Express web framework.
// Migrated from the native `http` module to Express to enable declarative
// routing while preserving the original single-file, CommonJS convention.
const express = require('express');

// Network binding retained exactly as the original native-http server.
const hostname = '127.0.0.1';
const port = 3000;

// Express application instance replaces the former `http.createServer(...)`.
const app = express();

// Root greeting endpoint - preserved for backward compatibility.
// Responds 200 with `Content-Type: text/plain` and the exact original body
// `Hello, World!\n` (including the trailing newline). `res.type('text/plain')`
// is set before `res.send(...)` so Express does not default the response to
// `text/html`, keeping byte-for-byte parity with the previous behavior.
app.get('/', (req, res) => {
  res.type('text/plain').send('Hello, World!\n');
});

// Additional greeting endpoint - returns the exact body `Good evening`
// (no trailing newline) as plain text for consistency with the root route.
app.get('/good-evening', (req, res) => {
  res.type('text/plain').send('Good evening');
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
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running at http://${hostname}:${port}/`);
});
