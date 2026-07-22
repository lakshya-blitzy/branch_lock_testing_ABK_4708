const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

// --- Robust request-processing configuration (added: bounds every request) ---
const ALLOWED_METHODS = ['GET', 'HEAD'];   // Root Cause 3: only these methods are served
const MAX_URL_LENGTH = 2048;                // Root Cause 3/5: cap request-target length (414)
const MAX_BODY_BYTES = 1024 * 1024;         // Root Cause 3/5: 1 MiB request-body cap (413)
const REQUEST_TIMEOUT_MS = 30000;           // Root Cause 4/5: whole-request timeout
const HEADERS_TIMEOUT_MS = 20000;           // Root Cause 4/5: header-receipt timeout
const KEEP_ALIVE_TIMEOUT_MS = 5000;         // Root Cause 4: idle keep-alive timeout
const SOCKET_TIMEOUT_MS = 30000;            // Root Cause 4: idle socket timeout (default 0 = off)
const SHUTDOWN_GRACE_MS = 10000;            // Root Cause 2: max drain time before force-close

// Root Cause 4: track live sockets so shutdown can drain / force-close them
const sockets = new Set();

const server = http.createServer((req, res) => {
  // Root Cause 5: never let a handler exception crash the process
  try {
    // Root Cause 5: handle per-request stream errors / client aborts
    req.on('error', (err) => {
      console.error(`Request stream error: ${err.message}`);
      if (!res.headersSent) { res.statusCode = 400; res.end(); }
    });
    res.on('error', (err) => console.error(`Response stream error: ${err.message}`));

    // Root Cause 3: reject overlong request targets (414 URI Too Long)
    if (req.url && req.url.length > MAX_URL_LENGTH) {
      res.statusCode = 414; res.setHeader('Content-Type', 'text/plain');
      // Issue #1 (RC5): the request body is never consumed on this early return, so
      // close the connection. On a keep-alive socket an undrained/declared body would
      // otherwise cause the client's next request to be mis-read as this request's
      // body (request-boundary desync / half-open connection until keepAliveTimeout).
      res.setHeader('Connection', 'close');
      res.end('URI Too Long\n'); return;
    }
    // Root Cause 3: enforce an HTTP method allow-list (405 Method Not Allowed)
    if (!ALLOWED_METHODS.includes(req.method)) {
      res.statusCode = 405; res.setHeader('Allow', ALLOWED_METHODS.join(', '));
      res.setHeader('Content-Type', 'text/plain');
      // Issue #1 (RC5): close on rejection so an undrained declared body cannot desync
      // a keep-alive connection (client's follow-up request swallowed / half-open).
      res.setHeader('Connection', 'close');
      res.end('Method Not Allowed\n'); return;
    }
    // Root Cause 3/5: reject oversized bodies by declared Content-Length (413)
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.statusCode = 413; res.setHeader('Content-Type', 'text/plain');
      // Issue #1 (RC5): the oversized declared body is never read on this early return,
      // so close the connection to prevent the client's next keep-alive request from
      // being consumed as this request's body (boundary desync / half-open connection).
      res.setHeader('Connection', 'close');
      res.end('Payload Too Large\n'); return;
    }
    // Root Cause 5: also enforce the body cap while streaming (chunked requests)
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        res.statusCode = 413; res.setHeader('Content-Type', 'text/plain');
        res.end('Payload Too Large\n'); req.destroy();
      }
    });
    // Preserve the original success response once the request is fully received
    req.on('end', () => {
      if (res.writableEnded) return;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Hello, World!\n');
    });
  } catch (err) {
    // Root Cause 5: convert unexpected errors into 500 instead of crashing
    console.error(`Unhandled request error: ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 500; res.setHeader('Content-Type', 'text/plain');
      res.end('Internal Server Error\n');
    }
  }
});

// Root Cause 4: bound header/request/idle durations (defaults leave socket timeout at 0)
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.setTimeout(SOCKET_TIMEOUT_MS);

// Root Cause 4: maintain the live-socket registry used by graceful shutdown
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// Root Cause 5: handle malformed requests without crashing (send 400, close socket)
server.on('clientError', (err, socket) => {
  console.error(`Client error: ${err.message}`);
  if (socket.writable && !socket.destroyed) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
});

// Root Cause 1: subscribe to 'error' so bind failures (EADDRINUSE/EACCES) log and exit cleanly
server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

// Root Cause 2: drain in-flight connections on termination signals, then exit
let isShuttingDown = false;
function shutdown(signal) {
  if (isShuttingDown) return;             // idempotent: ignore repeated signals
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed. All connections drained.');
    process.exit(0);
  });
  server.closeIdleConnections();          // release idle keep-alive sockets immediately
  setTimeout(() => {                       // force-close anything still open after the grace period
    console.error('Shutdown grace period elapsed; forcing remaining connections closed.');
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Root Cause 1: last-resort process-level safety nets
process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.stack || err.message}`);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled promise rejection: ${reason}`);
  shutdown('unhandledRejection');
});
