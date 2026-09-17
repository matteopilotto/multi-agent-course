# 2026-09-13 — LUMINA: the run log grows a Mongo half, and a regression rides along

## Goal
TECHNICAL.md Part 1, step 5: the run log. The file half already existed from the quick-loop
session (`runlog.ts`, commit `82872c3`), so this session built what DESIGN.md component 9
and SPEC §8 still asked for: a `runs` row per answer that `scripts/export-runs.mjs` can pull
back to disk, a `requests` row, and the one structured log line per answer from SPEC §10.
Tutored build-along in answers-now mode (short on time); I pasted the snippets myself.

## Context
- `runs/` held 23 files and `check.mjs` read them with 0 errors before I started.
- The contract already had `RunDoc` (= `RunLog` + `requestId`, `userId`, `threadId`,
  `answerId`, `query`, `createdAt`), `RequestDoc`, and `COLLECTIONS.runs` / `.requests`.
- `scripts/indexes.json` already declared both collections' indexes, including a **unique**
  index on `runs.requestId`.
- `export-runs.mjs` sorts on `createdAt` and writes only five fields to disk, dropping `depth`.

## What was done
One commit, `5aa85c3`, typechecked and linted first.

- **`env.ts`**: `nodeEnv` from `NODE_ENV`, default `development`.
- **`runlog.ts`**: `writeRunLog` replaced by `recordRun(doc: RunDoc)` (validate with
  `RunDoc.parse`, write the file only outside production using `RunLog.parse(doc)` to strip
  the Mongo-only keys, then `insertOne` into `runs`) and `recordRequest(doc: RequestDoc)`.
- **`index.ts`**: a `record(terminated, cost, status, answerId?)` helper inside the ask route
  builds both rows from `logBase()` and `state` with one shared `createdAt: new Date()`,
  runs them under `Promise.all`, and catches to `log.error('evidence write failed')`. The
  success branch gained the SPEC §10 `log.info('answer')` line (requestId, toolCalls,
  terminated, tokens, costUsd, searchCached, ttftMs, latencyMs); the catch branch logs the
  same numbers and records status 502.

Verified through the agent on :8000 (single runs):

| | result |
|---|---|
| "What is Tavily?" quick | `done`, ttft 6 072 ms, latency 9 258 ms, $0.033; newest file `req_mtzoqjrcvmwker`; `export-runs.mjs` pulled the same id back from Mongo; `check.mjs` 0 errors over 24 runs |
| same question with `TAVILY_API_KEY=bad` | pre-search `ok` (cache hit), 5 × `fetch_page` `ok: false` with the 401 body, model's second `web_search` missed the cache → `error` 502, no `done`; file `req_mtzov1xjz2mi2q` says `terminated: "error"`, 8 tool calls, $0.021; `ask failed` log line carries the id; exporter round-trips it |
| moved to `runs/failing/` | `check.mjs` back to 0 errors, P2 warning only |

Not verified: the `requests` rows themselves (only inferred from the absence of the
`evidence write failed` line; I never grepped for it), the production branch that skips the
file, and the duplicate-key path on a retried request id.

## Decisions
- **Mongo always, file only outside production.** Mongo is the system of record (the
  exporter and `/stats` read it); the file is what `check.mjs` reads locally. Alternatives
  named: file-or-Mongo by environment, both always.
- **Both writers stay in `runlog.ts`.** One call site, one instant, same numbers; a module
  per collection would split nothing.
- **Evidence writes are caught and logged.** They run after `done` or `error` is sent, so a
  throw cannot reach the caller, and Express 4 does not catch async rejections. This is the
  one deliberate catch in the ask path; the log line is what keeps it loud.
- **`createdAt` is a BSON `Date`**, the TTL-index lesson again: the exporter sorts on it and
  `/stats` will need `$gte` on a date.
- **A `cap` run records status 200.** It is an honest partial delivered with a `done` event.
- **`record` writes rows after `send('done')`**, so the Mongo round trip stays out of
  `latencyMs`: *rationale not discussed*, it fell out of keeping the old ordering.

## Dead ends
- **Regression, found while writing this entry, unfixed at the time of writing:** the
  success branch no longer calls `appendMessage` for the assistant turn. The tutor's
  instruction was "replace the single `writeRunLog` line", and I replaced through the
  `appendMessage` block that followed it. Same slip as the dropped `ttftMs` line in the
  cache session: a snippet that replaces a function ending must show the whole ending.
  Effect: follow-ups no longer see the answer and `GET /threads/:id` lacks assistant rows.
  Neither test in this session exercised a follow-up, so nothing caught it.
- The initial `curl ... | grep '^event: done' -A1` printed the curl progress meter over
  the output; harmless, but `-s` belongs on that command.

## Learnings
- **A cache can hide a provider outage for one step.** With a dead key the harness
  pre-search still succeeded, and the failure only surfaced at the first cache miss.
- **Two zod parses, two jobs.** `RunDoc.parse` validates; `RunLog.parse` on the same object
  strips the extra keys, the pydantic `extra='ignore'` behaviour, which is how the file
  keeps the declared shape without a hand-written projection.
- The failing run shows 5 consecutive `fetch_page` calls; `expectations.json` caps a streak
  at 4 (A3). It passed only because `runs/failing/` is not scanned. A successful run that
  picks five pages would fail the gate.
- Tavily's own 401 on `extract` is currently a tool error (`ok: false`), while the same 401
  on `search` is a provider error (502). The SPEC's example tool error is "403 from
  publisher"; a refusal from the provider itself should be `ProviderError` on both paths.

## Open questions and next steps
- Restore the assistant `appendMessage` after `record` (or before it) and verify with a
  follow-up question and `GET /threads/:id`.
- `requests` rows exist only for `/ask`. SPEC §8 gives them a `route` field and the `/stats`
  example shows requests ≫ answers, so every route should write one: a `res.on('finish')`
  middleware with the ask handler passing tokens/cost/terminated through `res.locals`.
  Then `record` shrinks to the `runs` row only. Natural start of the `/stats` session.
- Cap the fetch batch at 4 in `loop.ts`; reclassify extract 401/5xx in `tools.ts`.
- Inspect the `requests` rows directly once; grep the log for `evidence write failed`.
- Next: gateway (Part 2), or `/stats` first now that the rows exist.

**ADR candidates:** Mongo as the system of record for evidence with the file as a local
convenience; evidence writes after the response are logged, never thrown; one `requests` row
per request on every route via middleware, not per handler.
