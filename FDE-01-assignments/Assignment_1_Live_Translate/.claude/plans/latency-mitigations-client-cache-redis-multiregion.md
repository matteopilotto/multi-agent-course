# Plan — Latency & Cache Mitigations (client cache · shared Redis · US multi-region)

## Context

The Product Evaluation (`PRODUCT_EVAL.md`) benchmarked the deployed gateway and found the
backend logic is sound but three things underperform, all rooted in **deployment topology and
time-to-value**, not translation/cache correctness:

1. **Cache-hit latency ~0.55 s p95** (SLA ≤ 60 ms) and **throughput ~16 rps** (SLA ≥ 20) — both
   dominated by the public-internet round-trip from the client to a **single Fly region (`iad`)**.
   The same hit is ~0 ms server-side (43 ms p95 locally), so this is distance, not code.
2. **Cold full-page translation ~70 s** — the widget sends its 40-node batches **sequentially**
   ([widget/translation-widget.js:224](../../widget/translation-widget.js#L224)), and there is **no
   client-side cache**, so every re-translate re-crosses the network.
3. **Production cache does not persist** — the AI service `fly.toml` has no `[mounts]`, so its
   SQLite tier is ephemeral and resets on every deploy/restart (observed `db_hits: 0` after a
   restart), so the real hit rate and ~$55/mo savings erode.

**Goal:** cut hit/miss latency and lift throughput by (a) not crossing the network for repeat
strings, (b) parallelizing page translation, (c) sharing a persistent cache across machines, and
(d) placing machines closer to US users.

**Scope decisions (confirmed with the user):**
- **Edit the provided widget** (client cache + concurrent batches), and re-copy into `extension/`.
  This intentionally crosses the assignment's "don't edit provided files" red-line — acceptable as a
  post-submission product improvement.
- **Upstash Redis** as the shared persistent cache tier (keep in-memory as L1).
- **US multi-region**: keep `iad` (US-East), add `sjc` (US-West) for both apps.

---

## Workstream A — Widget: client cache + concurrent batches
*(files: `widget/translation-widget.js`, then `cp` to `extension/translation-widget.js`)*

**A1. Client-side translation cache (kills hit-latency RTT for repeats).**
- Add a module-level `Map` `clientCache` keyed by `` `${target}::${original}` ``, plus an optional
  `localStorage` mirror (namespaced key, e.g. `fde:tx:<target>:<sha-or-original>`), guarded in
  `try/catch` so it degrades gracefully where `localStorage` is unavailable. `localStorage` works in
  **all three** load modes; `chrome.storage` does not, so do not use it.
- In `translatePage()` ([widget:209](../../widget/translation-widget.js#L209)): before building each
  batch, split `slice` into **cache hits** (resolve locally, update DOM, count as hits) and
  **misses** (only these go in the `/translate/batch` `texts`). On response, write results back into
  `clientCache` (+ localStorage). Repeat re-translate of the same page then makes **zero** network
  calls.
- Keep the existing per-batch DOM update and `originalText` Restore logic intact.

**A2. Concurrent batches (cuts cold full-page time).**
- Replace the sequential `for … await postJSON` loop with **bounded-concurrency parallelism**: build
  all batch slices up front, run them through a small worker pool (cap ~5 in flight to stay well
  under the gateway's 120 req/min limit), and update the DOM in each batch's `.then` so **progressive
  rendering is preserved** — the page fills in as batches resolve instead of blocking ~70 s.
- Accumulate `hits`/`totalMs` across resolved batches; call `renderSummary` after all settle. Keep
  `busy`/`pageBtn.disabled` guards.

**A3. Re-copy to the extension.**
- `cp widget/translation-widget.js extension/translation-widget.js` (README documents this; the
  extension loads its own copy). No manifest change needed — `storage` permission already present.

---

## Workstream B — AI service: pluggable persistent tier (SQLite | Redis)
*(files: `backend/ai-service-python/lib/cache.py`, `app.py`, `requirements.txt`, `.env.example`)*

**B1. Refactor `TwoTierCache` to a pluggable persistent tier — reuse existing code.**
- Extract the current SQLite bodies of `init/get/set/size` ([cache.py](../../backend/ai-service-python/lib/cache.py))
  into a `SqliteTier` class (verbatim logic, same `translations` schema and `_key`), and add a
  `RedisTier` with the same async interface. `TwoTierCache` keeps the L1 memory dict + `_stats`
  (unchanged, so `/stats` shapes stay contract-correct) and delegates the persistent tier.
- Selection by env: `CACHE_BACKEND=sqlite` (default — preserves local "survives restart" behavior)
  or `redis`. Keep `_key = sha256(model::target::text)` unchanged so keys are portable across tiers.

**B2. `RedisTier` (Upstash).**
- Use `redis.asyncio` (add `redis>=5` to `requirements.txt`). Connect from `REDIS_URL` (`rediss://…`).
- `get` → `GET key`; `set` → `SET key value` with optional `EX` from `CACHE_TTL_SECONDS` (default:
  no expiry); `size` → `DBSIZE`; `init` → connect + `PING`. Value is the translated string (UTF-8).
- Wire `cache.init()` at startup ([app.py:49](../../backend/ai-service-python/app.py#L49)) to pick
  the tier from env; on Redis connect failure, **fail loud** at startup (don't silently fall back —
  consistent with the repo's fail-loud stance in `lib/llm.py`).

**B3. Config.**
- `.env.example`: add `CACHE_BACKEND=sqlite`, `# REDIS_URL=rediss://…`, `# CACHE_TTL_SECONDS=`.
- Note in comments that `_stats` counters remain **per-process** (so `/stats` hit-rate is per-machine
  in multi-region), while cache *content* is shared via Redis.

---

## Workstream C — Deploy: US multi-region + shared cache + provision Redis
*(files: `backend/ai-service-python/fly.toml`, `backend/gateway-node/fly.toml`; Fly CLI)*

**C1. Provision Upstash Redis on Fly** (private, lowest RTT from the AI service):
- `fly redis create` (Upstash-managed) in `iad`; capture the `rediss://` URL. Optionally add a
  **read replica in `sjc`** so US-West AI machines don't cross-region on L2 misses (L1 memory absorbs
  repeats regardless).
- `fly secrets set REDIS_URL=… CACHE_BACKEND=redis` **on the `ai-service-python` app only** (Redis
  never reachable from the browser; the gateway does not touch it, except optionally C4).

**C2. Multi-region both apps.**
- After deploying the new images: `fly scale count 2 --region iad,sjc` for **both**
  `ai-service-python` and `matteopilotto-livetranslate-gw`. Keep `auto_stop`/`auto_start`;
  set `min_machines_running = 1` in `fly.toml` for `iad` (primary) to avoid cold-start on the hot
  path, leaving `sjc` at 0 for cost (document the latency/cost tradeoff).
- AI service stays private (Flycast); the gateway's `AI_SERVICE_URL=http://ai-service-python.flycast`
  is already region-aware (routes to nearest healthy AI machine) — no gateway code change for this.

**C3. Deploy order:** ship code first (Workstream B image) → set Redis secrets → `fly deploy` AI
service → `fly deploy` gateway → scale both to `iad,sjc`.

**C4. (Optional) Shared rate limiter.** The gateway limiter is in-memory MemoryStore
([server.js:59](../../backend/gateway-node/server.js#L59)); multi-region makes it per-machine
(effective limit × machine count). If exact global limiting matters, back it with `rate-limit-redis`
against the same Upstash instance via a gateway `REDIS_URL` secret. Otherwise document the caveat and
leave as-is.

---

## Sequencing & commits

Per repo rules (`CLAUDE.md`): branch off `main`, small scoped commits, **no `Co-Authored-By` trailer.**
Branch: `feat/latency-mitigations`.

1. `feat(ai-service): pluggable cache tier (sqlite|redis) via CACHE_BACKEND` — Workstream B (B1–B3).
2. `feat(widget): client-side translation cache` — Workstream A1.
3. `perf(widget): translate page batches concurrently` — Workstream A2 + A3 (re-copy to extension).
4. `chore(deploy): US multi-region (iad+sjc) + Upstash Redis wiring` — Workstream C (fly.toml + docs).
5. `docs: update README "How I ran it" + PRODUCT_EVAL §4 follow-up` — note the new architecture.

---

## Verification (run, don't eyeball)

**Local (backend correctness — no regression):**
- `CACHE_BACKEND=sqlite` (default): start AI service + gateway; run the README self-verify (2nd
  identical call `cached:true` + much lower `latencyMs`; survives restart).
- `CACHE_BACKEND=redis REDIS_URL=…` against a local/Upstash Redis: repeat — 2nd call `cached:true`;
  **restart the AI service and confirm the hit persists** (proves shared/persistent tier); `/stats`
  hit-rate still well-formed.
- `python benchmark/bench.py` (local) still exits per SLA on hits; miss path unchanged.

**Widget (the two UX wins):**
- Load the widget on a real page; **Translate page**, then **Restore**, then **Translate again** →
  with DevTools Network open, the second translate makes **no `/translate/batch` calls** (client
  cache) and is visually instant.
- On first (cold) translate of a long page, confirm batches fire **concurrently** (Network shows
  parallel requests) and the page fills in progressively — total time drops sharply vs ~70 s.

**Deployed (the SLA numbers this plan targets):**
- `python benchmark/bench.py --target https://matteopilotto-livetranslate-gw.fly.dev --json benchmark/_bench.json`
  from a US client → expect **hit p95 and throughput to improve** (closer region) and cache to stay
  warm across a redeploy (`db_hits`/Redis `DBSIZE` > 0 after `fly deploy`).
- `curl -sf https://…gw.fly.dev/health` returns ok from both regions; `fly status` shows machines in
  `iad` + `sjc`.

## Risks / caveats to keep in mind
- **Editing provided files** (`widget/`, `extension/`) breaks the grading red-line — intended here.
- **`localStorage` client cache is per-origin** (per-site), not global — correct and desirable, but
  it won't share across domains; the in-memory `Map` covers the same-page re-translate case.
- **`/stats` hit-rate becomes per-machine** in multi-region (content shared, counters not).
- **Cold starts** on `sjc` (min 0) add one-time latency on first request per idle period.
- **Upstash L2 RTT** from `sjc` to an `iad`-only Redis on per-machine-cold keys — mitigated by the
  read replica (C1) and the L1 memory tier.
