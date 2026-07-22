# hello_world

> A minimal, zero-dependency Node.js HTTP server that answers every request with a fixed `Hello, World!` plain-text response.

`hello_world` is a single-file HTTP server built entirely on the Node.js core [`http`](https://nodejs.org/api/http.html) module (`server.js:L1`). It has no third-party dependencies, no request routing, and no runtime configuration — it exists to demonstrate the smallest useful Node.js HTTP server.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation and Setup](#installation-and-setup)
- [Running the Server](#running-the-server)
- [API Documentation](#api-documentation)
- [Code Walkthrough](#code-walkthrough)
- [Deployment Guide](#deployment-guide)
- [Troubleshooting](#troubleshooting)
- [Project Notes](#project-notes)
- [License](#license)

## Overview

`hello_world` — described in the package manifest as *"Hello world in Node.js"* (`package.json:L2-L4`) — is a minimal Node.js HTTP server built **solely** on the Node.js core `http` module (`server.js:L1`). No web framework (Express, Fastify, Koa, etc.) is involved.

Its behavior is deliberately simple:

- It answers **every** inbound request with an identical response: HTTP status `200` (`server.js:L7`), `Content-Type: text/plain` (`server.js:L8`), and the body `Hello, World!\n` (`server.js:L9`).
- It performs **no routing** — the HTTP method and URL path are ignored, so `GET /`, `POST /anything`, and `DELETE /foo/bar` all return the same result (`server.js:L6-L10`).
- It has **no configuration** — the host and port are hard-coded constants (`server.js:L3-L4`); there are no environment variables and no config files.

The server binds to the loopback address `127.0.0.1` on port `3000` and, once listening, logs `Server running at http://127.0.0.1:3000/` (`server.js:L12-L14`).

## Prerequisites

- **Node.js runtime.** Node.js **22.x LTS** is recommended. The program uses only the core `http` module (`server.js:L1`) and a template literal for its startup log (`server.js:L13`), so any modern Node.js LTS release works equally well — no runtime-specific APIs are required.
- **No third-party dependencies.** The project declares zero dependencies. `package.json` lists no `dependencies` or `devDependencies` (`package.json:L1-L11`), and `package-lock.json` (lockfileVersion `3`) contains no package tree beyond the project root itself (`package-lock.json:L1-L13`).

You can confirm your Node.js version with:

```bash
node --version
```

## Installation and Setup

Because the project has **zero dependencies**, setup is limited to obtaining the source. **`npm install` is not required** — there is nothing to install (`package.json:L1-L11`, `package-lock.json:L1-L13`).

Clone the repository and change into its directory:

```bash
# Clone the repository (replace the URL with your actual remote)
git clone <repository-url>

# Enter the project directory
cd hello_world
```

That's it — no dependency installation step is needed. Proceed directly to [Running the Server](#running-the-server).

## Running the Server

Start the server directly with Node.js, pointing at the real entry point, `server.js` (see [Project Notes](#project-notes) for why it is not `index.js`):

```bash
node server.js
```

Once the server is listening, it prints the following line exactly (`server.js:L13`):

```text
Server running at http://127.0.0.1:3000/
```

The process then stays in the foreground, serving requests until you stop it with `Ctrl+C`.

### Startup flow

The sequence from launching the process to the confirmation log (`server.js:L1,L6,L12-L14`):

```mermaid
flowchart LR
    A["Operator runs: node server.js"] --> B["require('http')"]
    B --> C["http.createServer(handler)"]
    C --> D["server.listen(3000, 127.0.0.1)"]
    D --> E["Log: Server running at http://127.0.0.1:3000/"]
```

## API Documentation

The server exposes a **single implicit, catch-all endpoint**. There is **no REST routing**: the HTTP method and URL path are ignored, so every request — regardless of method or path — receives the identical response (`server.js:L6-L10`).

### Endpoint contract

| Attribute | Value |
|-----------|-------|
| Method | Any (ignored — no routing) |
| Path | Any (ignored — no routing) |
| Base URL | `http://127.0.0.1:3000/` |
| Status code | `200` |
| Response `Content-Type` | `text/plain` |
| Response body | `Hello, World!\n` |

The response contract is fixed in the request handler: the status code is set to `200` (`server.js:L7`), the `Content-Type` header is set to `text/plain` (`server.js:L8`), and the body is `Hello, World!\n` — including the trailing newline (`server.js:L9`). The base URL is derived from the hard-coded host and port constants (`server.js:L3-L4`).

### Request/response flow

```mermaid
sequenceDiagram
    participant C as Client (curl / browser)
    participant S as server.js @ 127.0.0.1:3000
    C->>S: HTTP request (any method, any path)
    S->>S: res.statusCode = 200
    S->>S: res.setHeader('Content-Type', 'text/plain')
    S-->>C: 200 OK, body "Hello, World!\n"
```

### Smoke test

With the server running (see [Running the Server](#running-the-server)), issue a request in another terminal:

```bash
curl http://127.0.0.1:3000/
```

Expected output (the trailing newline from `Hello, World!\n` places the shell prompt on the next line):

```text
Hello, World!
```

To also inspect the status line and headers, use `curl -i`:

```bash
curl -i http://127.0.0.1:3000/
```

This shows the `HTTP/1.1 200 OK` status (`server.js:L7`) and the `Content-Type: text/plain` header (`server.js:L8`) alongside the `Hello, World!` body (`server.js:L9`).

## Code Walkthrough

The entire runtime lives in `server.js` (`server.js:L1-L15`). The source now also carries JSDoc annotations — a module `@file` overview, `@constant` blocks on the host/port constants, and `@param`-annotated blocks on the request handler and startup callback — that describe the same units explained below. The runtime logic itself is unchanged; the JSDoc additions are comments only.

The runtime code is:

```javascript
const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
```

Line by line:

- **`require('http')` (`server.js:L1`)** — Loads the Node.js core `http` module. This is the only import in the file and the sole dependency of the whole program.
- **`hostname` and `port` constants (`server.js:L3-L4`)** — `hostname` is the loopback address `'127.0.0.1'` (`server.js:L3`) and `port` is `3000` (`server.js:L4`). Both are hard-coded; there is no environment-variable or config-file override.
- **Request handler (`server.js:L6-L10`)** — The callback passed to `http.createServer((req, res) => { ... })` runs for every request. It performs exactly three statements:
  1. `res.statusCode = 200;` — sets the HTTP status to `200` (`server.js:L7`).
  2. `res.setHeader('Content-Type', 'text/plain');` — declares a plain-text body (`server.js:L8`).
  3. `res.end('Hello, World!\n');` — writes the body `Hello, World!\n` (with the trailing newline) and ends the response (`server.js:L9`).

  The `req` argument is never read: the method, URL, headers, and body of the request are all ignored, which is why there is no routing.
- **Startup callback (`server.js:L12-L14`)** — `server.listen(port, hostname, () => { ... })` binds the server to `127.0.0.1:3000` and, once it is ready to accept connections, invokes the callback whose only side effect is logging `Server running at http://127.0.0.1:3000/` via a template literal (`server.js:L13`).

## Deployment Guide

This server is intended for local development and demonstration. Its runtime characteristics are fixed in code:

- **Loopback binding.** The server binds to the loopback interface `127.0.0.1` (`server.js:L3`, `server.js:L12`). As a result, it is reachable **only from the local machine** and is **unreachable from other hosts** on the network.
- **Fixed port.** It listens on port `3000` (`server.js:L4`). Because both host and port are hard-coded constants, **changing either requires a code edit** — there is no environment variable or CLI flag to override them.
- **No TLS.** Traffic is plain HTTP; there is no HTTPS/TLS termination in the server.
- **No authentication or authorization.** Every request is served the same response; there are no access controls.

### Starting, backgrounding, and stopping

Run in the foreground (stop with `Ctrl+C`):

```bash
node server.js
```

Run in the background (the shell returns immediately and prints the job's PID):

```bash
node server.js &
```

Stop a backgrounded instance — for example, by bringing the job to the foreground and interrupting it, or by killing its PID:

```bash
# If it is a job of the current shell:
kill %1

# Or, find and stop the process by port:
kill "$(lsof -t -i:3000)"
```

### Exposing the server externally (conceptual)

Because the server binds to loopback only (`server.js:L3`, `server.js:L12`), external exposure is not possible without additional steps. Conceptually, there are two approaches:

1. **Front it with a reverse proxy.** Place a reverse proxy such as **nginx** on a public interface and forward traffic to `127.0.0.1:3000`. This is the recommended pattern because the proxy can add TLS, authentication, rate limiting, and logging without changing the application.
2. **Change the bind address.** Binding to `0.0.0.0` (all interfaces) would make the server reachable from other hosts, but because the host is a hard-coded constant (`server.js:L3`), this would require **editing the source** — it is not configurable at runtime.

## Troubleshooting

- **`Error: listen EADDRINUSE: address already in use 127.0.0.1:3000`** — Another process is already bound to port `3000` (`server.js:L4`). The port is hard-coded, so the fix is to free the port: stop the conflicting process (for example, `kill "$(lsof -t -i:3000)"`), or stop the other application using port `3000`, then start the server again with `node server.js`.
- **`curl` from another machine fails / connection refused** — This is expected. The server binds to the loopback interface `127.0.0.1` (`server.js:L3`, `server.js:L12`), so it only accepts connections originating from the same machine. Requests from other hosts cannot reach it. See the [Deployment Guide](#deployment-guide) for how external exposure would be approached.
- **`Cannot find module '.../index.js'`** — This happens if you try to start the project via its declared `main` entry (`package.json:L5`) rather than the real file. Start it with `node server.js` instead; see [Project Notes](#project-notes).

## Project Notes

- **Entry-point discrepancy (documented, not fixed).** `package.json` declares `"main": "index.js"` (`package.json:L5`), but **no `index.js` file exists** in the project. The real entry point is `server.js`, so always start the server with `node server.js`. This note documents the discrepancy intentionally; the source is left unchanged.
- **Placeholder test script.** The `scripts.test` entry in `package.json` is the default placeholder (`echo "Error: no test specified" && exit 1`) (`package.json:L7`). There is no test suite, and this placeholder is left unchanged.

## License

This project is licensed under the **MIT License** (`package.json:L10`).

Author: `hxu` (`package.json:L9`).
