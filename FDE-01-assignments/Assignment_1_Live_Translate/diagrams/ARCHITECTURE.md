# Live Translate — Architecture

A browser widget translates any English web page into **Mexican Spanish (es-MX)** on
demand. Behind it are **two backend services** — a public Node gateway and a private
Python AI service — deployed multi-region on Fly.io with a shared cache.

> **Diagram:** [`architecture-overview.drawio`](architecture-overview.drawio) — the
> full system (this document). For the narrower "why is the AI service private?" story,
> see [`architecture-before-flycast.drawio`](architecture-before-flycast.drawio) /
> [`architecture-after-flycast.drawio`](architecture-after-flycast.drawio).
>
> **Open / edit:** these are draw.io files. In Lucidchart: **File → Import Diagram → Draw.io**;
> or open directly at [app.diagrams.net](https://app.diagrams.net).

---

## 1. The shape at a glance

```
Browser (widget) ──①──▶ Node Gateway :8787 ──②──▶ Python AI Service :8000 ──④──▶ LLM provider
   any web page          PUBLIC (Anycast)          PRIVATE (Flycast, no public IP)     (OpenRouter)
                         CORS·validate·rate-limit    translate_one: L1 ─③─▶ L2 ─④─▶ LLM
                         log·trace·proxy·/widget.js                 memory   SQLite | Redis
```

Three moving parts. The **frontend is provided and works**; the assignment is to build
the **two backend services** it talks to.

| Layer | Component | Public? | Path |
|---|---|---|---|
| Client | Widget · Chrome extension (MV3) · console loader · demo page | n/a (browser) | `widget/`, `extension/`, `loader/`, `demo-pages/` |
| Edge | **Node Gateway** `:8787` (Express) | ✅ Anycast public IP | `backend/gateway-node/` |
| AI | **Python AI Service** `:8000` (FastAPI) | 🔒 Flycast private only | `backend/ai-service-python/` |
| Cache L1 | In-memory dict (per-process) | — | `lib/cache.py` |
| Cache L2 | SQLite (`translations.db`) **or** Upstash Redis | — | `lib/cache.py` |
| External | LLM provider (OpenRouter default; vLLM optional) | external | `lib/llm.py` |

**Why two services?** Browser-facing concerns (CORS, validation, serving assets, rate
limiting, request logs) are genuinely different from AI concerns (prompts, model choice,
caching, API keys). Splitting them means each deploys and fails independently — and your
**API key never lives on the edge the browser can reach**.

---

## 2. Client (provided — you don't build this)

The **widget** (`widget/translation-widget.js`) is the whole UI: it renders the
bottom-right translate button, chunks the page's visible text, calls the gateway, swaps
the text in place, and shows **cache-hit badges** with latency. It reaches the backend
three ways:

- **Chrome extension (MV3)** — `content.js` injects the widget on `<all_urls>` (so it
  works even on strict-CSP sites like homedepot.com); the popup stores the backend URL +
  target language in `chrome.storage`, exposed to the widget as `window.FDE_CONFIG`.
- **Console loader** — paste `loader/console-snippet.js` in DevTools (permissive pages only).
- **Demo page** — `demo-pages/index.html` for local testing.

The client only ever talks to the **gateway**. It never sees the AI service, the cache, or the API key.

---

## 3. Node Gateway `:8787` — the public edge

`backend/gateway-node/server.js` (Express). It is the **only door in**. Responsibilities:

- **CORS** — open to all origins in dev so the widget works on any page.
- **Validation** — bad input → `400` (e.g. `text` not a string).
- **Per-IP rate limiting** — `express-rate-limit`, keyed on the real client IP
  (`fly-client-ip` header, falling back to `req.ip`); over the limit → `429` + a friendly
  message and `Retry-After`.
- **Request logging** — one structured JSON line per request to `gateway.log`
  (`method`, `url`, `status`, `durationMs`, `requestId`).
- **Tracing** — sets a request ID (reuses inbound `X-Request-Id` if present, else generates
  one) and forwards it to the AI service as `x-request-id`, so a single request is greppable
  end-to-end across **both** services' logs.
- **Serving + proxying** — serves the widget at `/widget.js`; proxies `/translate`,
  `/translate/batch`, `/health`, `/stats` to the AI service via `callAiService()`. An upstream
  failure surfaces as `502` (never a silent success).
- **Health** — `GET /health` nests the AI service's own health so one call proves the whole chain.

It holds **no secrets** and **no cache** — it is pure edge logic.

---

## 4. Python AI Service `:8000` — the real work

`backend/ai-service-python/app.py` (FastAPI). Private (Flycast only). It owns the LLM call,
the cache, and the **provider API key**.

**`translate_one()`** is the core flow (`app.py`):

1. Strip the text; empty → return empty (no LLM).
2. **`cache.get()`** — check **L1 (memory)**, then **L2 (SQLite/Redis)**. Hit →
   `{ cached: true, latencyMs, ... }` with a tiny latency.
3. Miss → **`translate_text()`** (one LLM round-trip), then **`cache.set()`** into *both*
   tiers, and return `{ cached: false, latencyMs, ... }`.

Identical `(text, target)` therefore **never calls the LLM twice**.

**`/translate/batch`** ("Translate page") fans out concurrently under an
`asyncio.Semaphore(BATCH_CONCURRENCY)`, de-duplicates on the stripped cache-key form, and
marks repeat occurrences within a batch as cache hits — so translating a whole page is fast
and cheap.

**`/health`** → `{ status, model, cacheSize }`. **`/stats`** → cache counters +
`hit_rate_pct` (per-process).

### 4.1 The LLM call — `lib/llm.py`

One OpenAI-compatible `AsyncOpenAI` client for every vendor:

- `LLM_PROVIDER=openrouter` (default) — Claude / GPT / Gemini via one API; `MODEL` uses
  OpenRouter slugs (e.g. `anthropic/claude-sonnet-4.6`).
- `LLM_PROVIDER=vllm` — a self-hosted OpenAI-compatible endpoint.

The system prompt pins **natural Mexican Spanish (es-MX)**, translation-only (no preamble/
quotes), preserving numbers, prices (`$`), and product/model codes. Other targets (es-ES,
it, fr, de) are supported via `LANG_INSTRUCTIONS`.

**Fail-loud by design:** a provider error is *not* caught — it propagates so the gateway
returns `502`. The service **never returns the untranslated English as if it succeeded**
(a silent fallback would ship English while looking healthy — an automatic fail).

### 4.2 The cache — `lib/cache.py`

`TwoTierCache` with a shared async interface (`init/get/set/size/stats`):

- **L1 — in-memory `dict`.** Instant, per-process, lost on restart. Checked first.
- **L2 — pluggable persistent tier**, selected by `CACHE_BACKEND`:
  - **`sqlite`** (default) — `translations.db`, a local file that survives restart on one machine.
  - **`redis`** — Upstash Redis: shared and persistent **across machines/regions**. Startup
    pings Redis and **fails loud** if unreachable (no silent fallback).
- **Cache key** = `sha256(f"{model}::{target}::{text}")` — deterministic and portable across
  tiers, so switching model/language produces a clean **miss** rather than serving another
  model's stale output.

> **Stats caveat:** with Redis the cache *content* is shared, but the `/stats` hit/miss
> counters live on each process — so `hit_rate_pct` is **per-machine**.

---

## 5. Deployment — Fly.io, multi-region

Two Fly apps; full runbook in [`../backend/DEPLOY.md`](../backend/DEPLOY.md).

| Role | Fly app | Public? |
|---|---|---|
| Gateway (Node) | `matteopilotto-livetranslate-gw` | ✅ Yes (Anycast) |
| AI service (Python) | `ai-service-python` | 🔒 No — Flycast private only |

- **Regions:** `fra` (EU, **primary — kept warm** via `min_machines_running = 1`) and `iad`
  (US-East, secondary — scales to 0 when idle). Fly's Anycast routes each visitor to the
  nearest healthy gateway machine.
- **Flycast privacy:** the AI service has **no public IP**. The gateway reaches it at
  `http://ai-service-python.flycast` over the private 6PN network. Flycast (not `*.internal`)
  is used specifically because it routes through the Fly proxy — which preserves
  **wake-on-request** for stopped machines *and* load-balances across instances.
- **Shared cache:** Upstash Redis (`livetranslate-cache`) with the primary in `fra` and a read
  replica in `iad`, so cache **reads** are region-local (the hit-latency SLA) and only **writes**
  (misses, already ~2 s LLM calls) cross regions. `REDIS_URL` + `CACHE_BACKEND=redis` are set on
  the AI service only — the gateway never touches the cache.
- **Local dev:** `docker compose up --build` boots both services (gateway `:8787`, AI `:8000`);
  the SQLite cache persists in a named volume.

---

## 6. Request lifecycle (one translation, end to end)

1. **① Browser → Gateway.** Widget `POST /translate` over HTTPS (CORS, public Anycast). The
   gateway validates, rate-limits, assigns/reuses a request ID, and logs the request.
2. **② Gateway → AI service.** Proxied to `…flycast` over the private network with
   `x-request-id`.
3. **③ Cache lookup.** `translate_one` checks **L1 memory**, then **L2 (SQLite | Redis)**. A
   hit returns immediately with `cached: true` and a few-ms latency — **step ④ is skipped**.
4. **④ LLM (miss only).** On a full miss, one HTTPS call to the LLM provider with the API key;
   the result is written to **both** cache tiers, then returned with `cached: false`.
5. **Logs.** Both services log a structured line carrying the **same request ID**, so one
   request is greppable across `gateway.log` and `ai-service.log`.

The whole point is the gap: a **hit** is dramatically faster (and effectively free) than a
**miss**. That's what the SLA in `benchmark/sla.json` measures — hit p95 ≤ 60 ms, miss
p95 ≤ 3500 ms, hit rate ≥ 60 %.

---

## 7. Key design decisions

| Decision | Why |
|---|---|
| **Two services, not one** | Isolate edge concerns from AI concerns; keep the API key off the internet-facing box; independent deploy/failure. |
| **AI service private via Flycast** | The browser only touches the gateway; direct `:8000` hits (bypassing CORS/validation/rate-limit) are impossible from the internet. |
| **Two-tier cache (memory + persistent)** | L1 gives instant repeats; L2 survives restart (SQLite) or is shared across regions (Redis). |
| **Pluggable L2 via `CACHE_BACKEND`** | Same key + interface; SQLite for a single box, Redis for multi-region — config-only switch. |
| **`sha256(model::target::text)` key** | Deterministic and collision-safe; a model/language change is a clean miss, never a stale hit. |
| **OpenAI-compatible client for all vendors** | One request/response path; swap provider/model via env, no code change. |
| **Fail-loud on LLM error → 502** | Never ship untranslated English while looking healthy. |
| **`fra` warm + `iad` scale-to-0** | EU hot path never pays a cold start; US traffic gets a nearer machine on demand at lower idle cost. |
