# 600K_ChildRepo

A minimal Node.js tutorial server. `server.js` uses Express to serve two plain-text endpoints.

## Requirements

Node.js **>= 18**, declared as `engines.node` in `package.json` because `express@5.2.1` itself
declares `engines: { "node": ">= 18" }`.

## Install

```bash
npm install
```

Installs the one runtime dependency, `express@5.2.1` — pinned exactly, with no caret range —
plus its 67 transitive packages, 68 in total.

## Run

```bash
npm start
```

Runs `node server.js`, which logs exactly:

```text
Server running at http://127.0.0.1:3000/
```

The host `127.0.0.1` and the port `3000` are hard-coded in `server.js`; neither has an
environment-variable override.

## Test

```bash
npm test
```

Runs `node --test test/*.test.js`, which executes the 3 tests in `test/server.test.js`. The suite
needs no extra dependencies — it uses Node's built-in `node:test` and `node:assert/strict` — and it
binds an ephemeral port, so it never contends with port `3000`.

## Endpoints

| Method | Path            | Status | Content-Type | Response body                                             |
| ------ | --------------- | ------ | ------------ | --------------------------------------------------------- |
| GET    | `/`             | 200    | `text/plain` | `Hello, World!\n` — 14 bytes, **with** a trailing newline |
| GET    | `/good-evening` | 200    | `text/plain` | `Good evening` — 12 bytes, **no** trailing newline        |

Notes on the response contract:

- **`Content-Type` is bare `text/plain` on both routes, with no `charset` parameter.** That is a
  deliberate contract rather than an oversight: both handlers write their response with the Node
  core APIs (`res.statusCode`, `res.setHeader`, `res.end`) instead of `res.send()`, which would
  rewrite the header to `text/plain; charset=utf-8`.
- **The newline asymmetry between the two bodies is intentional.** `Hello, World!\n` keeps its
  historical trailing newline because that byte is part of the existing response contract, while
  `Good evening` reproduces the requested string exactly, with nothing appended.
- Any unmatched path, and any non-`GET` method, now returns **404** from Express's default handler —
  for example `GET /nope` or `POST /`. This is new behaviour: before routing was introduced the
  server answered `200` for every path and method. It is the intended, unavoidable consequence of
  serving two distinct endpoints.
- `HEAD /` returns **200**, answered automatically from the matching `GET /` route.
