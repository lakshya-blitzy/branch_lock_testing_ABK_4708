# 600K_ChildRepo

This repository aggregates fragments from several unrelated upstream projects. The
Node.js HTTP service rooted at `server.js` is its only runnable, network-reachable
component, and it is the only thing this document describes.

## Getting started

**Runtime:** Node.js `>= 20.0.0`, as declared by `engines` in `package.json`. The
repository's Maven build pins Node **24.16.0** (`pom.xml` line 102), and that is the
version every command and expected result below was verified against.

```bash
npm ci      # install the pinned dependency set
npm start   # equivalently: node server.js
```

**The service starts with zero configuration.** No environment variable and no
certificate material is required — a deliberately preserved property, not an accident.
With nothing set it listens on **`127.0.0.1:3000`**, and `GET /` returns `200` with a
body of exactly `Hello, World!\n` (14 bytes).

That observable contract is unchanged by the security hardening. What *has* changed is
that requests which previously succeeded only because no control existed are now
refused — see [Security controls](#security-controls) and the note on
[intended rejections](#intended-rejections).

## Security controls

Every request passes through one linear pipeline, mounted in this order:

```text
helmet  →  cors  →  rate limiter  →  method allow-list  →  body parsers (size-capped)
        →  zod validation  →  route table  →  404 handler  →  error handler
```

**The order is load-bearing, not cosmetic.** `helmet` is first so the headers apply to
error responses as well as successful ones; `cors` precedes the method allow-list so
preflights are answered before `OPTIONS` can be rejected; and the method allow-list is
top-level middleware rather than a catch-all route, because a catch-all route does not
match the root path and would leave `TRACE /` unguarded. The reasoning, and the runtime
evidence behind each rule, is in [`docs/security/hardening.md`](docs/security/hardening.md).

| Control | Observable effect |
|---|---|
| Security response headers (`helmet`) | Helmet's twelve default headers plus an explicitly enabled `Cross-Origin-Embedder-Policy`, on **every** response including `4xx` and `5xx`. `X-Powered-By` is suppressed |
| HTTP method allow-list | Only `GET` and `HEAD` are served. Every other verb receives `405` with an `Allow: GET, HEAD` header. `TRACE`, `TRACK` and `CONNECT` can never be admitted, even through configuration |
| Route table | Unknown paths receive `404`; there is no wildcard route |
| Request-body ceiling | Bodies above `JSON_BODY_LIMIT` are rejected with `413` before a parser reads a byte |
| Schema validation (`zod`) | Malformed path, query, header or body input receives `400`, with no internal detail disclosed |
| Rate limiting | Once a client exhausts its per-window budget it receives `429` with `Retry-After` and standards-track draft-8 `RateLimit` / `RateLimit-Policy` headers |
| HTTPS transport | Opt-in TLS listener with an enforced **TLSv1.2** minimum; obsolete protocol versions are refused at the handshake and the floor cannot be weakened by configuration |
| CORS origin allow-list | Deny-by-default exact-match allow-list. `Access-Control-Allow-Origin` is emitted only for permitted origins, and `Vary: Origin` is always set so no cache can serve one origin's response to another |
| Audit logging | Structured JSON records for each request, plus explicit security events for rate-limit rejections, origin denials, method rejections and validation failures |
| Error responses | All rejections are RFC 9457 `application/problem+json`. No stack trace, internal path or dependency version is ever disclosed |

### Intended rejections

Six categories of request that previously returned `200` now fail **by design**. They
are the remediation, not regressions:

- non-allow-listed methods → `405`
- unknown paths → `404`
- oversized or malformed bodies → `413` / `400`
- clients over the rate budget → `429`
- non-allow-listed origins lose browser read access
- clients that cannot negotiate TLS 1.2 or better are refused, when TLS is enabled

## Configuration

Every security setting is read from the process environment by `config/security.js`,
which is the single source of truth. Exactly these eleven variables are read — there is
no `NODE_ENV`, no log level, no database URL and no authentication setting, because the
service has no such surface.

| Variable | Default | Effect |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address (the previously hard-coded literal, preserved) |
| `PORT` | `3000` | Listen port (preserved). Range `0`–`65535`; `0` requests an OS-assigned port |
| `ALLOWED_ORIGINS` | *empty → **deny all cross-origin*** | Comma-separated list of exact origins permitted to read responses from a browser |
| `ALLOWED_METHODS` | `GET, HEAD` | Permitted HTTP verbs; every other verb receives `405` |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 minutes) | Rate-limit accounting window, in milliseconds |
| `RATE_LIMIT_MAX` | `100` | Per-client request budget per window |
| `JSON_BODY_LIMIT` | `1kb` | Maximum accepted request-body size. Accepts `b`/`kb`/`mb`/`gb`/`tb`/`pb` or a plain byte count |
| `TLS_ENABLED` | `false` | Opt in to the HTTPS listener |
| `TLS_KEY_PATH` | unset | **Path** to the TLS private key — never inline key material |
| `TLS_CERT_PATH` | unset | **Path** to the TLS certificate — never inline material |
| `HSTS_MAX_AGE` | `31536000` (1 year) | `Strict-Transport-Security` max-age, always emitted with `includeSubDomains` |

Two settings are deliberately **not** variables and cannot be weakened at runtime under
any name: the TLS protocol floor (`TLSv1.2`) and `includeSubDomains`.

[`.env.example`](.env.example) is the copyable, secret-free template documenting all
eleven. Copy it to `.env` and populate it for your deployment: a populated `.env` is
**git-ignored**, while `.env.example` itself stays tracked. The application does not
load `.env` itself — there is no `dotenv` dependency — so supply the values the way your
platform supplies environment variables:

```bash
PORT=8080 ALLOWED_ORIGINS=https://app.example.com node server.js   # per invocation
set -a; . ./.env; set +a; node server.js                           # from a local .env
```

Configuration **fails closed**. Unset, empty or whitespace-only is treated as absent and
the documented default applies — and every default above is the restrictive outcome. A
value that is present but unparseable is never guessed: startup is refused with an
explanatory error rather than running with a silently weakened policy. `ALLOWED_ORIGINS=*`
is rejected outright for the same reason.

### Deployment coordination point — read this before deploying

**`ALLOWED_ORIGINS` defaults to empty, which denies every cross-origin caller.** Any
legitimate browser-based consumer must therefore be enumerated before or at deployment:

```bash
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

This is a configuration action, not a code change, and it is the single operational step
this hardening requires. Deny-by-default is the deliberate choice: a permissive wildcard
would nominally satisfy "configure CORS" while leaving the vulnerability entirely
unremediated. Origins are compared as exact, lowercased strings — there is no globbing
and no regular-expression matching, so `https://*.example.com` would match nothing.

## Enabling HTTPS

Set `TLS_ENABLED` together with both path variables, then start the service normally:

```bash
TLS_ENABLED=true \
  TLS_KEY_PATH=/absolute/path/outside/repo/server.key \
  TLS_CERT_PATH=/absolute/path/outside/repo/server.crt \
  npm start
```

Both paths are required when TLS is on; a missing, unreadable or empty file refuses
startup rather than quietly falling back to cleartext for a deployment that explicitly
asked for encryption. The listener enforces a **TLSv1.2** minimum, so a TLS 1.0 or 1.1
client is rejected during the handshake and never reaches the application.

Key and certificate material is referenced **by filesystem path only** — never inline in
code, in `.env.example`, or in any file inside the repository — and must live **outside
the checkout**, readable only by the service account. `.gitignore` excludes `*.pem`,
`*.key`, `*.crt`, `*.p12` and `*.pfx` so a stray copy cannot be committed by accident,
but keeping the material outside the repository entirely is the actual requirement.
**Provisioning, storage, rotation and distribution of real certificates is an operational
activity outside this code change.**

`Strict-Transport-Security` is emitted **unconditionally**, including over plain HTTP
where browsers ignore it. That is intentional, not a defect: the header is inert and
harmless in the cleartext default and becomes effective the instant TLS is enabled, which
removes the class of bug where it is forgotten at exactly that moment.

## Verification

```bash
npm test                          # node --test "test/**/*.test.js"
npm audit --audit-level=high      # expect: "found 0 vulnerabilities", exit 0
```

> **The quoted glob is mandatory.** `npm test` runs
> `node --test "test/**/*.test.js"`. The directory form is **not** equivalent — it fails
> on Node v24.16.0 with `Error: Cannot find module '<repo>/test'` (`MODULE_NOT_FOUND`),
> which makes a perfectly working suite look broken. Always pass the quoted glob.

With the service running on its default address:

```bash
# Security headers, and the absence of X-Powered-By
curl -sS -D - -o /dev/null http://127.0.0.1:3000/

# Body integrity — exactly 14 bytes, "Hello, World!\n"
curl -sS http://127.0.0.1:3000/ | od -c

# Method matrix against the root path
for m in GET HEAD POST PUT DELETE PATCH OPTIONS TRACE; do
  printf "%-8s -> " "$m"
  curl -sS -o /dev/null -w "%{http_code}\n" -X $m http://127.0.0.1:3000/
done

# Rate-limit saturation, against a deliberately small budget
RATE_LIMIT_MAX=5 RATE_LIMIT_WINDOW_MS=60000 npm start   # in another shell
for i in $(seq 1 8); do
  curl -sS -o /dev/null -w "%{http_code} " http://127.0.0.1:3000/
done; echo
```

Expected results:

| Probe | Expected |
|---|---|
| Header enumeration | Thirteen security headers — `Content-Security-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Origin-Agent-Cluster`, `Referrer-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Frame-Options`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection` — plus `Vary: Origin` and the `RateLimit` headers. No `X-Powered-By` |
| Body integrity | Exactly `H e l l o ,   W o r l d ! \n`, 14 bytes |
| Method matrix | `200 200 405 405 405 405 204 405`, with `Allow: GET, HEAD` on each `405` |
| Rate-limit saturation | `200 200 200 200 200 429 429 429`, with `Retry-After` on each `429` |
| Unknown path | `404` |

Two expected results routinely surprise people, so both are spelled out below.

### `X-XSS-Protection: 0` is correct

Current guidance is to **disable** the legacy XSS auditor, which introduced
vulnerabilities of its own. A value of `0` is the intended, modern setting — it is not a
misconfiguration, and it should not be "fixed" to `1; mode=block`.

### `OPTIONS` returns `204`, and a denied origin is never rejected by status

The `cors` middleware short-circuits **every** `OPTIONS` request with `204` — including
preflights from origins that are *not* on the allow-list, and requests carrying no
`Origin` header at all. This is why the method matrix above shows `204` for `OPTIONS`
rather than `405`: the preflight is answered before the method allow-list is consulted.

**The control is the absence of the `Access-Control-Allow-Origin` header, not the status
code.** A denied origin's request still succeeds at the HTTP level; what is withheld is
the header that would permit the browser to hand the response to the calling page. A
reader expecting `403` will wrongly conclude the allow-list is missing. Check the headers:

```bash
# Denied origin — expect NO Access-Control-Allow-Origin, but Vary: Origin present
curl -sS -D - -o /dev/null -H 'Origin: https://rogue.invalid' http://127.0.0.1:3000/

# Allowed origin — expect Access-Control-Allow-Origin echoing the origin
ALLOWED_ORIGINS=https://app.example.com npm start   # in another shell
curl -sS -D - -o /dev/null -H 'Origin: https://app.example.com' http://127.0.0.1:3000/
```

| Request | Status | `Access-Control-Allow-Origin` |
|---|---|---|
| Allowed origin, simple request | `200` | present, echoing the origin |
| Denied origin, simple request | `200` | **absent** |
| Allowed origin, preflight | `204` | present, with `Access-Control-Allow-Methods: GET,HEAD` |
| Denied origin, preflight | `204` | **absent** |

`Vary: Origin` is present in all four cases.

## Further reading

- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability in this project, the
  supported versions, and what to expect after you report it.
- [`docs/security/hardening.md`](docs/security/hardening.md) — control-by-control
  rationale with CVE and advisory references, the threat-to-control mapping, the
  mandatory middleware ordering rules and the evidence behind them, and the rollback
  procedure.
