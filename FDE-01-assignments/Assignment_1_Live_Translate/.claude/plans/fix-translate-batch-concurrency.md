# Fix `/translate/batch` concurrency

## Context

The `/translate/batch` endpoint in the Python AI service processes a batch **sequentially** —
it `await`s `translate_one()` inside a `for` loop
([app.py:98-99](FDE/Assignment_1_Live_Translate/backend/ai-service-python/app.py#L98-L99)).
The browser widget sends up to **40 text nodes per call**
([BATCH_SIZE: 40](FDE/Assignment_1_Live_Translate/widget/translation-widget.js#L33)), so a page
of fresh (uncached) text incurs up to 40 back-to-back LLM round-trips. Latency scales linearly
with batch size, making full-page translation painfully slow.

**Goal:** translate a batch concurrently while (a) capping simultaneous LLM calls to avoid
provider rate limits, (b) collapsing duplicate strings so each unique text is translated once,
and (c) preserving output order and the existing fail-loud contract.

## Constraints discovered

- **Order matters.** The widget maps `results[j]` → the j-th input node by index
  ([widget:207-213](FDE/Assignment_1_Live_Translate/widget/translation-widget.js#L207-L213)).
  Output must stay index-aligned with `body.texts`.
- **Fail loud.** `lib/llm.py` requires provider errors to propagate (→ gateway 502), not be
  swallowed. A batch with any failed item should raise. (User confirmed: fail the whole batch.)
- **Duplicates are common** on real pages (nav labels, buttons). Dedup avoids redundant LLM calls.
- **SQLite writes:** `lib/cache.py` opens a fresh `aiosqlite` connection per op. aiosqlite's
  default 5s busy timeout means concurrent writers wait rather than error; with concurrency
  capped at 8 and dedup in place, "database is locked" is very unlikely. No change needed here.

## Approach (edit one file: `app.py`)

### 1. Add config + import
- `import asyncio` at the top.
- `BATCH_CONCURRENCY = int(os.getenv("BATCH_CONCURRENCY", "8"))` near the other env reads
  (after `MODEL` / `DB_PATH`).

### 2. Rewrite `translate_batch` ([app.py:93-107](FDE/Assignment_1_Live_Translate/backend/ai-service-python/app.py#L93-L107))

Reuse the existing `translate_one()` unchanged (it already does strip → empty-check → cache →
LLM → cache-set). Wrap it in a semaphore, dedup on the **stripped** text (which is exactly what
`translate_one` and the cache key `_key()` normalize on), then fan results back out in order:

```python
@app.post("/translate/batch")
async def translate_batch(body: BatchIn, request: Request):
    request_id = request.headers.get("x-request-id")
    t0 = time.perf_counter()

    sem = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def guarded(text: str) -> dict:
        async with sem:
            return await translate_one(text, body.target)

    # keys in original order; dedup on the stripped form (cache-key semantics)
    keys = [(t or "").strip() for t in body.texts]
    rep: dict[str, str] = {}
    for t in body.texts:
        rep.setdefault((t or "").strip(), t)
    unique_keys = list(rep.keys())

    # concurrent, bounded; any provider error propagates -> 502 (fail loud)
    done = await asyncio.gather(*(guarded(rep[k]) for k in unique_keys))
    by_key = dict(zip(unique_keys, done))

    # fan back out in original order; mark 2nd+ occurrences of a key as a hit
    results, seen = [], set()
    for k in keys:
        r = by_key[k]
        if k in seen:
            r = {**r, "cached": True}   # duplicate within batch == effectively cached
        else:
            seen.add(k)
        results.append(r)

    latency = int((time.perf_counter() - t0) * 1000)
    hits = sum(1 for r in results if r["cached"])
    log.info("translate_batch", extra={"count": len(results), "hits": hits,
                                       "latencyMs": latency, "requestId": request_id})
    return {"results": [{"translated": r["translated"], "cached": r["cached"]} for r in results],
            "latencyMs": latency}
```

**Why the `seen` / duplicate-as-hit line:** dedup means both positions of a repeated string share
one result dict (`cached=False`). Without this, the `hits` metric would under-count intra-batch
duplicates vs. the old sequential behavior (where the 2nd "Home" was a memory hit). Marking 2nd+
occurrences `cached=True` keeps hit accounting faithful. Response shape is unchanged.

### 3. (Optional) document the knob
Add `BATCH_CONCURRENCY=8` with a comment to
[backend/ai-service-python/.env.example](FDE/Assignment_1_Live_Translate/backend/ai-service-python/.env.example)
so the concurrency cap is discoverable.

## Out of scope
- No change to `lib/cache.py` or `lib/llm.py` (busy timeout already covers the write path).
- No cross-request in-flight coalescing (dedup is per-batch only) — not needed for the widget's
  usage and adds shared global state.

## Verification

1. **Start the service** (from `backend/ai-service-python/`):
   `uvicorn app:app --port 8000` (needs `ANTHROPIC_API_KEY` in `.env`).
2. **Order + dedup, manual:**
   ```
   curl -s localhost:8000/translate/batch -H 'content-type: application/json' \
     -d '{"texts":["Home","Add to cart","Home","Checkout"],"target":"es-MX"}' | jq
   ```
   Expect 4 results, index-aligned; results[0] and results[2] have identical `translated`;
   results[2].cached == true. Check server logs: `hits` reflects the duplicate.
3. **Latency win:** POST a batch of ~12 distinct fresh strings and confirm `latencyMs` is roughly
   a single-call latency × ceil(12 / BATCH_CONCURRENCY), not 12× a single call. Re-POST the same
   batch → all `cached:true`, near-zero latency.
4. **Fail loud:** temporarily set an invalid `ANTHROPIC_API_KEY`, POST a fresh batch, confirm the
   endpoint raises (non-200 / 502 through the gateway) rather than returning English text.
5. **Regression:** run the shape check — `python eval/eval.py --target http://localhost:8000`
   (it posts a 2-item batch and asserts the `{results:[...], latencyMs}` shape).
