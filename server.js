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
app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
