# 2026-09-17 — LUMINA: Spaces, the jobs worker, and what the failure tests found

## Goal
TECHNICAL.md Part 1, step 6: Spaces and the `jobs` worker, upload → GridFS → parse → chunk →
embed → read-your-write probe → `indexed`. Step 0 was the regression left open by the last
entry. The session ran long (2026-09-13 to 2026-09-17) and ended with four follow-ups, two of
which I closed. Tutored build-along, answers-now mode throughout; I pasted the snippets.

## Context
- The contract already had `SpaceDoc`, `DocumentDoc`, `ChunkDoc`, `JobDoc`, `DocStatus` and
  `MAX_UPLOAD_BYTES`; `scripts/indexes.json` already declared `chunks_vector` (with `spaceId`
  and `userId` as filter fields) and `chunks_text`.
- `benchmark/bench.mjs` uploads with the multipart field name `file` and polls
  `GET /spaces/{id}/documents` for `indexed`, so both are fixed by the grader, not by me.
- `eval/gold/corpus/` holds four documents, two of them PDFs with stable page numbers.

## What was done
Twelve commits, `2c7e7d2`..`dc2c42d`, each typechecked and linted first. New modules:
`spaces.ts`, `documents.ts`, `jobs.ts`, `chunks.ts`, `ingest.ts`, `retrieval.ts`, `errors.ts`,
and a real `worker.ts`. `dev-upload.sh` at the assignment root uploads files and polls to a
terminal status.

Verified against the live agent and worker on :8000 (single runs unless noted):

| | result |
|---|---|
| all four gold documents | `indexed`, chunks 9 / 7 / 8 / 6, `pages` 4 and 3 on the PDFs |
| read-your-write probe | 391 ms / 1 poll, 1 712 / 2, 2 537 / 2, 4 234 / 4 |
| upload `202`, local | 1.44 s first after a restart, 0.55 s steady; phase timings put one Atlas round trip at ~130 ms and the handler at four hops |
| `OPENAI_API_KEY=bad` | job `failed` at `attempts: 1`, document `failed` at `pct: 10` with `openai embeddings 401 … invalid_api_key` |
| worker `kill -9` mid-job | swept, `requeued: 1`, reclaimed at `attempt: 2`, `indexed`; `chunks` held exactly 7 rows with contiguous ids `docId:0..6`, so the retry was idempotent |
| simulated `ProviderError(…, 503)` | `attempts: 2` → `indexed`, error cleared |
| `fetchPage` with a bad Tavily key | `ProviderError`, status 401; with the real key, 167 chars, no throw |

Proposed but **not applied**: the A3 per-turn tool cap in `loop.ts`, and `GET /stats`
(`stats.ts` + route). Snippets and the settled design decisions are in `HANDOFF.md`, which is
git-excluded locally.

## Decisions
- **The assistant turn is written before `send('done')`.** `messages` is authoritative state
  and `done` promises a follow-up will see it; `runs` and `requests` are evidence and may
  trail. Alternative discussed and rejected: keep the write after `done`, which can emit
  `done` and then `error` on one stream.
- **The job row is written last**, after the GridFS bytes and the document row, because it is
  the trigger: a worker must never claim work whose inputs are missing. The other two run
  under `Promise.all` since the ids are generated in the app.
- **One `GridFSBucket` per process.** Measured: the driver's index check is per instance and
  cost ~400 ms on the first upload.
- **multer is invoked by hand** so `LIMIT_FILE_SIZE` becomes `413` instead of falling into the
  `502` handler and calling a user's oversized file an upstream failure.
- **The chunk unit is the citation grain** — PDF page, Markdown heading, whole text file —
  and only an over-long unit is split, gaining a `line` so no two chunks share a locator.
- **The probe targets the middle chunk**, since a first chunk is often a title page and could
  be near-duplicated across a Space. The id match makes this belt and braces.
- **A retry deletes the document's chunks first**, which is what made the `kill -9` test come
  back with 7 rows rather than 14.
- **`failJob` classifies by provider status.** 401/403/429/5xx from Tavily, and `retryable`
  on `ProviderError`, decide requeue versus permanent failure. A bad key dies at one attempt;
  a 503 costs a retry rather than the document.
- **The document row gets a capped one-line error, the log keeps the full one**, because the
  row renders in the provided UI and the log is for me.
- **`setDocumentStatus` throws on an empty patch.** Mongo would reject it anyway with a
  message naming the operator and not the call site.
- **`ProviderError` moved to `errors.ts`**: three modules need it and only one searches the web.

## Dead ends
- **The step-6 snippet ate `findDocument`.** The tutor's replacement ended on a closing brace
  without showing the function beneath it, so I replaced to end of file. Third occurrence of
  this exact pattern (`ttftMs`, then `appendMessage`, now this). The typecheck caught it only
  because `worker.ts` imported the deleted function.
- **`$unset: { error: '' }` would not compile.** An object literal in an unannotated `const`
  widens `''` to `string`, and the driver accepts only `true | '' | 1`. Annotating
  `const update: UpdateFilter<DocumentDoc>` restored the literal type.
- **Atlas refused TLS with alert 80 and no peer certificate.** My first explanation, a VPN,
  was wrong and I was corrected. TCP was open and the server hung up before offering a
  certificate, which is the IP-allowlist signature. Opened to `0.0.0.0/0`.
- **`/health` still said `db: down` after the allowlist was fixed.** `db.ts` assigned `client`
  before `connect()` resolved, so one refusal poisoned the process forever; a fresh process
  pinged fine, which is what isolated it. Now it caches the connect promise and forgets it on
  rejection (`bf0be02`).
- **Two attempts to test the extract reclassification end to end failed.** Both asks reused a
  thread that already had messages, so the loop took the follow-up branch, which skips the
  harness pre-search; the typed question was therefore never a search and never a cache key.
  `searchCache` held one row, `"Tavily Extract pricing"`, a query the model had invented.
  Abandoned for a five-line direct call to `fetchPage` in `scratch.ts`, which tests the claim
  with no model in the loop.
- A snippet comment (`// already imported; keep one copy`) was pasted as code, duplicating an
  import. `/tmp/s.json` vanished across a reboot and the empty shell variable turned every
  upload into `POST /spaces//documents` and a `404`.

## Learnings
- **Eventual consistency, measured.** Inserts returned immediately and the chunk stayed
  invisible to `$vectorSearch` for up to 4.2 s. A worker that flipped to `indexed` on insert
  would have been lying for that window. Four runs, one cluster.
- **`Promise.all` rejects on the first rejection without waiting for its siblings.** A sibling
  tool call finished 12 ms later and wrote its `trace` after the terminal `error` event. Fixed
  with a `dead` flag guarding the wire; `toolCalls` still records the call, because it happened.
- **Async history lives in the counters, not the final state.** I read a retried job's `done`
  as the test not firing; the evidence was `attempts: 2` and the cleared error.
- **The search cache is keyed on the search query, not the user's question.** Those coincide
  only on the first message of a thread, where the harness pre-search runs.
- **Local `202` latency is a hop count, not an SLA reading.** Four hops at ~130 ms each cannot
  meet 300 ms from this laptop; the agent has to deploy in the Atlas region.

## Open questions and next steps
- Apply the A3 per-turn cap and `GET /stats` (snippets in `HANDOFF.md`). The cap is per turn,
  not across turns, which the `pages.length >= 2` break makes unlikely but does not prevent.
- Step 8, hybrid retrieval: the BM25 half plus RRF, `search_documents`, page locators,
  recall@5. `retrieval.ts` already holds the proven dense half.
- The gateway (Part 2) has now slipped three sessions and carries 10 points plus the UI.
- Still open from the last entry: one `requests` row per route via middleware.
- `GET /threads/:id` is not `safeParse`d. Eight stale `failed` rows sit in the demo Space.
  `0.0.0.0/0` needs to reach the run notes on `/evals`.

**ADR candidates:** authoritative state is written before the success signal and evidence may
trail it; the job queue is one atomic `findOneAndUpdate` plus a sweeper and an attempt limit,
not a broker; `indexed` is earned by a read-your-write probe, never by a successful insert;
provider failures are classified retryable by HTTP status, and that classification decides
whether a job is requeued.
