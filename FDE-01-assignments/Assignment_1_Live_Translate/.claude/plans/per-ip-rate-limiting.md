# Plan — Per-IP Rate Limiting on the Gateway (429 + friendly widget message)

## Context

`README.md:397` lists a stretch goal: *"Rate limiting on the gateway (per-IP) with a
`429` + friendly widget message."* Today the Node gateway proxies every `/translate` and
`/translate/batch` request straight to the LLM-backed AI service with no throttle — every
cache **miss** costs a real LLM call, so an abusive or runaway client (or a hammering
browser) drives cost and load with nothing standing in the way.

This change adds a per-IP rate limiter on the gateway (the only service the browser can
reach) that returns HTTP `429` with a JSON body + `Retry-After`, and teaches the widget to
render a **friendly** rate-limit message instead of the generic "Backend error (HTTP 429)".

Decisions confirmed with the user:
- **Implementation:** `express-rate-limit` (standard, per-IP keying, `Retry-After`/`RateLimit-*` headers, custom 429 handler).
- **Scope:** limit `/translate` **and** `/translate/batch` only (not `/health`, `/stats`, `/widget.js`); generous default **120 req/min/IP** (env-overridable) so a full page translate — many `/translate/batch` calls at 40 nodes each — isn't throttled.
- **Widget message:** edit the widget (and re-copy to the extension) for a true friendly 429 message. *Note: this trips the "no edits to `widget/`/`extension/`" grading red-line — accepted as a deliberate stretch-goal trade-off.*

## Changes

### 1. Gateway limiter — `backend/gateway-node/` (inline, no new source file)

Keeping the limiter inline in `server.js` avoids editing `Dockerfile.compose` (it only
`COPY`s `server.js`); the Fly `Dockerfile` does `COPY . .` so it's unaffected either way.

**`package.json`** — add dependency `express-rate-limit` (^7), then `npm install`.

**`server.js`** — three edits:
- Require it: `const rateLimit = require("express-rate-limit");` (near the other requires, ~line 16-21).
- Trust the Fly proxy so we key on the real client IP, not Fly's internal socket IP.
  Add after `const app = express();` (~line 34): `app.set("trust proxy", true);`
- Define the limiter and mount it **after the logger middleware (after line 54), before the routes**, so every 429 is still logged with a `requestId`. Mount with `app.use("/translate", translateLimiter)` — the path prefix matches both `/translate` and `/translate/batch` and nothing else:

```js
const translateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 120,
  standardHeaders: true,   // RateLimit-* + Retry-After
  legacyHeaders: false,
  // Fly forwards the real client IP here; fall back to req.ip locally / in docker-compose.
  keyGenerator: (req) => req.get("fly-client-ip") || req.ip,
  validate: { trustProxy: false }, // we handle proxy IP explicitly above
  handler: (req, res) => {
    const retryAfterSec = Math.ceil((Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000) / 1000);
    logLine({ event: "rate_limit", ip: req.get("fly-client-ip") || req.ip, url: req.originalUrl, requestId: req.requestId });
    res.status(429).json({ error: "Too many requests — please slow down and try again in a moment.", retryAfterSec });
  },
});
app.use("/translate", translateLimiter);
```

Reuses the existing `logLine()` helper (server.js:24-28) for the rejection log, and keeps
the `{ error: "..." }` body shape used everywhere else in the gateway.

**`.env.example`** — document the two knobs:
```
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

> Caveat to note in commit/PR: the store is in-memory, so limits are **per gateway
> instance**. Single-machine Fly setup (`min_machines_running = 0`, one machine) makes this
> fine; a multi-instance deploy would need a shared store (Redis) — out of scope here.

### 2. Friendly 429 in the widget — `widget/translation-widget.js`

Mirror the existing `NotImplemented` (501) pattern:
- In `postJSON` (lines 259-268), **before** the generic `if (!res.ok)` (line 266), add:
  ```js
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new RateLimited(body.error, res.headers.get("Retry-After"));
  }
  ```
- Add a `RateLimited` constructor next to `NotImplemented` (lines 317-321), carrying
  `message` and `retryAfter`.
- In `handleError` (lines 301-310), add a branch (before the generic `HTTP` branch):
  ```js
  if (err instanceof RateLimited) {
    setStatus(err.message || "You're translating too fast — please wait a few seconds and try again.", true);
    return;
  }
  ```
  Renders in the existing `#fde-status` line (red via `.fde-status.err`).

### 3. Re-copy widget to the extension — `extension/translation-widget.js`

Per the README note (line 182-183), the extension bundles its own copy. Apply the identical
edit (simplest: `cp widget/translation-widget.js extension/translation-widget.js`).

## Critical files

- `FDE/Assignment_1_Live_Translate/backend/gateway-node/server.js` — limiter (main change)
- `FDE/Assignment_1_Live_Translate/backend/gateway-node/package.json` — add dep
- `FDE/Assignment_1_Live_Translate/backend/gateway-node/.env.example` — document knobs
- `FDE/Assignment_1_Live_Translate/widget/translation-widget.js` — friendly 429 branch
- `FDE/Assignment_1_Live_Translate/extension/translation-widget.js` — re-copied

## Commits (branch off `main`, small scoped commits, no Co-Authored-By trailer)

1. **Gateway:** add `express-rate-limit`, per-IP limiter on the translate routes, `.env.example` knobs.
2. **Widget/extension:** friendly 429 handling in `postJSON`/`handleError`, re-copy to extension.

## Verification

Run the AI service + gateway locally (`docker compose up --build`, or each `npm start` /
`uvicorn`), then:

1. **Trips the limit → 429 with the right shape.** Fire >120 requests in a minute:
   ```bash
   for i in $(seq 1 130); do \
     curl -s -o /dev/null -w "%{http_code}\n" localhost:8787/translate \
       -H 'content-type: application/json' -d '{"text":"hi","target":"es-MX"}'; \
   done | sort | uniq -c        # expect a block of 200s then 429s
   ```
   Then inspect one rejection for the body + headers:
   ```bash
   curl -s -D - localhost:8787/translate -H 'content-type: application/json' \
     -d '{"text":"hi","target":"es-MX"}' -o /dev/null   # (after tripping) → RateLimit-*, Retry-After
   ```
   Confirm `{ "error": "...", "retryAfterSec": 60 }` body and a `Retry-After` header.
2. **Only translate routes are limited.** After tripping the limit, `curl -s localhost:8787/health`
   and `/stats` still return 200.
3. **Rejections are logged.** `grep '"event":"rate_limit"' backend/gateway-node/gateway.log`
   shows one line per 429, each with a `requestId`.
4. **Friendly widget message.** Load the widget (demo page or extension), lower
   `RATE_LIMIT_MAX` (e.g. `2`) in `.env`, restart the gateway, click Translate a couple
   times → the `#fde-status` line shows the friendly rate-limit copy in red (not
   "Backend error (HTTP 429)").
5. **Per-IP keying (deployed).** On Fly, `curl -H 'Fly-Client-IP: 1.2.3.4'` vs a different IP
   should be bucketed separately (optional; local has no Fly header so it falls back to `req.ip`).
6. **No regressions:** a normal single page translate on the demo page completes without
   hitting the limit at the default 120/min.
