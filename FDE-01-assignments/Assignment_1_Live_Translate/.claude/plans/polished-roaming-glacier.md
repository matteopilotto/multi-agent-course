# Plan: Implement the Live Translate backend (FDE Assignment 1)

## Context

FDE Assignment 1 ships a **working frontend** (widget, console loader, Chrome extension) and asks
the learner to build the **two backend services** it talks to. The scaffolding is ~90% done with six
`TODO (YOU)` blocks across three files. The goal is a working, observable, SLA-passing backend that
makes the provided widget "light up" unmodified — verified for real, not by inspection
(per [`AGENTS.md`](../../AGENTS.md)).

**Decisions locked in with the user:**
- **Provider:** Anthropic, keeping the scaffolding's `MODEL=claude-sonnet-4-6` (a current active model;
  right cost/latency fit for the SLA — miss p95 ≤ 3500 ms). Provider kept swappable, key from `.env`.
  Plain `messages.create` — no thinking/streaming (short UI strings).
- **Scope:** implement + verify locally. **No Fly.io deploy**, **no `/fde-live-translate-eval`** run
  (both are follow-ups after this passes).
- **Git workflow:** one feature branch per service, **sequential** (gateway branches off ai-service),
  **step-by-step commits**, and **a PR per feature** pushed to the `personal` remote
  (`github.com/matteopilotto/multi-agent-course`, gh authed as matteopilotto — `origin` is the
  read-only upstream).

All paths below are under `FDE/Assignment_1_Live_Translate/`.

---

## Branch & commit workflow

```
main
 └─ feat/ai-service-translate         (Part 1 — commits 1–3)  → PR #A (base: main)
     └─ feat/gateway-proxy            (Part 2 — commits 4–6)  → PR #B (base: feat/ai-service-translate)
```

- Cut `feat/ai-service-translate` off `main`; implement Part 1 as **3 commits** (one per TODO group);
  verify the AI service in isolation; push to `personal`; open PR #A (base `main`).
- Cut `feat/gateway-proxy` off `feat/ai-service-translate`; implement Part 2 as **3 commits**;
  run full end-to-end verify; push to `personal`; open **stacked** PR #B (base
  `feat/ai-service-translate`) — retarget to `main` after #A merges.
- Every commit message ends with the required trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- PR bodies end with the `🤖 Generated with [Claude Code]` line.
- Hygiene: never stage `.env`, `.venv/`, `node_modules/`, `*.db`, `*.log` (already git-ignored).

---

## Part 1 — Python AI service  (branch `feat/ai-service-translate`)

**Commit 1 — `lib/llm.py`: Mexican-Spanish LLM call.**
`backend/ai-service-python/lib/llm.py` → implement `translate_text()`:
`AsyncAnthropic()` (reads `ANTHROPIC_API_KEY`) → `await client.messages.create(model=..., max_tokens=1024,
system=<es-MX, translation-only, preserve numbers/$/product codes>, messages=[{"role":"user","content":text}])`;
return `msg.content[0].text.strip()`. **Hard rule:** no `try/except` that returns `text` on failure — let
the exception propagate so the gateway returns 502 (silent English passthrough = automatic fail).

**Commit 2 — `lib/cache.py`: SQLite tier.**
`backend/ai-service-python/lib/cache.py` → implement `init()` (`CREATE TABLE IF NOT EXISTS translations(...)`
+ index on `key`, via `aiosqlite`), `get()` SQLite branch (`SELECT translated WHERE key=?`; on hit bump
`access_count`, warm `self._mem[k]`, record `db_hits`, return; on miss record `misses`, return `None`),
and `set()` (upsert the row; the memory tier + `_key()` sha256 + stats are already provided).

**Commit 3 — `app.py`: wire cache→LLM→cache.**
`backend/ai-service-python/app.py` → implement `translate_one()`: `await cache.get()` → hit returns
`{cached:True,...}`; miss `await translate_text()` → `await cache.set()` → `{cached:False,...}`; compute
`latencyMs` from `t0` on **both** paths.

**Verify Part 1 in isolation** (background `uvicorn`, foreground `curl`):
```
cp .env.example .env   # add ANTHROPIC_API_KEY
uvicorn app:app --port 8000        # (run_in_background)
curl -s localhost:8000/health
# run twice — 2nd must be "cached":true with much lower latencyMs
curl -s localhost:8000/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning, welcome!","target":"es-MX"}'
# restart uvicorn → repeat → still "cached":true (SQLite persistence)
```

---

## Part 2 — Node gateway + trace correlation  (branch `feat/gateway-proxy`, off Part 1)

**Commit 4 — request-logging middleware + request-id (server.js TODO #1).**
`backend/gateway-node/server.js` → `app.use((req,res,next)=>{...})`: derive a request id (reuse inbound
`X-Request-Id` header if present, else generate one — `crypto.randomUUID()`), stash on `req`, and on
`res.on("finish")` log one structured line: method, url, status, duration ms, **request id**.

**Commit 5 — `callAiService()` proxy (server.js TODO #2).**
Implement the helper: `await fetch(AI_SERVICE_URL+path, {method:"POST", headers:{content-type,
"x-request-id":<id>}, body:JSON.stringify(body)})`; `if(!res.ok) throw` so `/translate` + `/translate/batch`
return 502; `return res.json()`. Thread the request id from the middleware into the forwarded header.

**Commit 6 — AI service logs the forwarded id (cross-service trace).**
`backend/ai-service-python/app.py` → read the inbound `x-request-id` in the `/translate` (and
`/translate/batch`) handlers and add it to the existing `log.info("translate", extra={...})` line so one
request is greppable end-to-end across `gateway.log` + `ai-service.log` (AGENTS.md trace requirement).

**Verify end-to-end** (both servers backgrounded; `bench.py` foreground):
```
# gateway
cd backend/gateway-node && npm install && cp .env.example .env && npm start   # :8787 (background)
curl -sf localhost:8000/health && curl -sf localhost:8787/health
# contract + cache proof through the gateway (run twice)
curl -s localhost:8787/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning","target":"es-MX"}'
python benchmark/bench.py                 # MUST exit 0 (SLA gate)
grep "<request-id>" gateway.log ai-service.log   # id appears in BOTH
git diff --stat -- widget extension       # MUST show no changes
git status --porcelain | grep -E '\.env$|node_modules|\.venv|\.db$' && echo FAIL || echo clean
```

---

## Verification summary (Definition of Done — run every check, don't assume)

1. Both `/health` endpoints answer.
2. Repeat `/translate` → 2nd `cached:true`, latency far lower.
3. Restart AI service → still `cached:true` (SQLite survives).
4. `python benchmark/bench.py` exits `0` (hit p95 ≤ 60 ms, miss p95 ≤ 3500 ms, hit rate ≥ 60%, throughput ≥ 20 req/s).
5. One request id greppable across both log files.
6. `git diff --stat -- widget extension` clean; no secrets/junk staged.

Tracked live with `TodoWrite`. If any check fails, fix the backend — not the widget, benchmark, or SLA.

---

## Out of scope (explicit)
- Fly.io deploy (needs your Fly account + interactive login).
- `/fde-live-translate-eval` skill run / `PRODUCT_EVAL.md` (the submission step — after this passes).
- Requires `ANTHROPIC_API_KEY` in `backend/ai-service-python/.env` for the miss-path and `bench.py` verify.
