# hello_world

A minimal Node.js HTTP server built with the [Express.js](https://expressjs.com/) web framework. It exposes two plain-text endpoints on the loopback interface `127.0.0.1:3000`.

## Dependencies

Exactly one direct dependency:

- **express** — declared as `^5.1.0` (resolves to `5.2.1`).

Transitive packages are pinned in `package-lock.json` and installed into `node_modules/`.

## Prerequisites

- **Node.js** >= 18 (validated on Node.js v22.23.1)
- **npm** (bundled with Node.js)

## Install & Run

```bash
npm install   # install dependencies (express)
npm start     # start the server (runs `node server.js`)
```

`npm start` is defined in `package.json` and simply runs `node server.js`, which you may also invoke directly. Once running, the server listens on the loopback interface `127.0.0.1:3000` and logs:

```
Server running at http://127.0.0.1:3000/
```

## Endpoints

| Method | Path | Status | Content-Type | Response body |
|--------|------|--------|--------------|---------------|
| `GET` | `/` | `200` | `text/plain` | `Hello, World!\n` (includes a trailing newline) |
| `GET` | `/evening` | `200` | `text/plain` | `Good evening` (no trailing newline) |

## Example requests

```bash
curl http://127.0.0.1:3000/         # Hello, World!
curl http://127.0.0.1:3000/evening  # Good evening
```
