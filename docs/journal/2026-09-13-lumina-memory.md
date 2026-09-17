# 2026-09-13 — LUMINA: long-term memory, and who owns which tool call

## Goal
TECHNICAL.md Part 1, step 4: `save_memory` / `recall_memory` over the `memories` vector
index, `GET /memory`, `DELETE /memory/{id}`, and the rubric's proof: a preference stated in
thread A changes the answer in thread B, is listed, and its effect disappears on delete.
Tutored build-along in answers-now mode (short on time), followed by a conceptual tail I
asked for: harness vs. model ownership, the layering of `backend/agent/src/`, and `mode`.

## Context
- `memories_vector` was already queryable on Atlas, with `userId` as a filter field.
- The contract already had `MemoryDoc`, `Memory` / `ListMemoryResponse`, `newId('mem')`,
  and both tool names in the `AskTool` enum, so trace and run-log validation needed no change.
- The loop is two-phase, research (Haiku, tools on) then answer (Sonnet, no tools). That
  shape decided where each memory tool could live.

## What was done
Four commits on `fde_cohort2`, one per step, typechecked and linted first.

1. **`embed.ts`** (`2fcf881`): one native-fetch call to `/v1/embeddings`, throwing on
   non-2xx or a length other than `EMBEDDING_DIMS`. Verified: 200 and 1 536 dims.
2. **`memory.ts`** (`7f4fc9f`): `saveMemory` (embed + insert, `sourceThread`),
   `recallMemory` (`$vectorSearch` on `memories_vector`, `userId` filter *inside* the stage,
   `$project` renaming `_id` → `id`, `$meta: 'vectorSearchScore'`, plus a
   `mongo-cosine-scan` branch), `listMemories`, `deleteMemory`. Verified in `scratch.ts`:
   recall scored 0.56 for "how do I call Tavily?" against the TypeScript preference (one run).
3. **Routes** (`bc5a826`): `GET /memory` typed as `ListMemoryResponse`;
   `DELETE /memory/:memoryId` 204, 404 when missing or another user's; 501 loop skips
   `/memory`. Staged as a partial `index.ts` via `hash-object` + `update-index` so the
   commit typechecks alone.
4. **Loop wiring** (`5dda79c`): `RunContext {userId, threadId}` parameter; `recall_memory`
   as a harness step at phase 0, `Promise.all` with the pre-search on a fresh question;
   `save_memory` in `TOOL_SCHEMAS` and `dispatch`; `memoryBlock` (10 rows / 4 000 chars)
   into both prompts; `embed.ts` throws `ProviderError`.

Verified through the agent on :8000 (single runs):

| | trace | answer | ttft | cost |
|---|---|---|---|---|
| A: "I build in TypeScript and want code examples, not prose." | recall 0 (1 851 ms, cold), `save_memory` ok | confirms, cites nothing | 8 983 ms | $0.028 |
| B: "how do I call Tavily?" | recall 1 (438 ms) | "Since you build in TypeScript", TS snippet, `[2][3]` resolve | 8 707 ms | $0.041 |
| DELETE → 204, repeat → 404, list empty | | | | |
| C: same question, fresh thread | recall 0 | Python prose, no snippet | 4 519 ms (cache hit) | $0.025 |

`GET /memory` showed the row with `sourceThread` = thread A. `check.mjs` exits 1 with only
the P2 warning; both run logs carry `recall_memory` in `toolCalls`.

Not verified: the `ProviderError` path (OpenAI down → 502), the `mongo-cosine-scan`
branch, and the `memoryBlock` caps. All exist and typecheck; none was exercised.

## Decisions
- **Native fetch instead of the `openai` SDK.** Its bundled `node-fetch` fails on Node 22.23
  with `Premature close` (seen). Alternative discussed: `import 'openai/shims/web'`. Chose
  the direct call because it matches `tools.ts` and removes a dependency from the request path.
- **Recall is a harness step, not a model choice.** A model that forgets to recall is a
  memory feature that silently does not exist: a gate, not a suggestion. One embedding plus
  one query, hidden behind the pre-search. The model has no `recall_memory` tool of its own.
- **Save is a model tool in the research phase.** It needs judgment, and research is the
  only phase with tools and with trace steps that precede `sources`.
- **Embedding failures are `ProviderError`.** OpenAI is a provider; rule A1 wants a 502.
- **Recalled rows go into both prompts.** The save tool's "never save something already
  listed" rule only works if the research phase sees the list.
- **`deleteMemory` filters on `userId`**, the same 404-over-leak rule as threads.
- **Caps of 10 rows / 4 000 chars** follow SPEC §5.3's "~10 documents / 1 000 tokens".
- `numCandidates = max(50, k·10)`, `k` default 5 but called with 10: *rationale not discussed*.

## Dead ends
- **`openai` SDK `Premature close`** on the first scratch run. Not my code; see above.
- **`b[i]` possibly undefined** in the cosine fallback under `noUncheckedIndexedAccess`.
  Tutor snippet bug, fixed with `?? 0` before the step-2 commit.
- **The `ProviderError` tweak was not on disk** at commit time; the tutor applied it.
- Observed, not fixed: on thread A the phase-0 pre-search ran on the preference *statement*
  and fetched two pages (one `ok: false`), all wasted. A statement is not a query, but the
  harness cannot tell yet.

## Learnings
- **"The model thinks, the harness does."** Ownership test: *is this step allowed to not
  happen?* No → harness (caps, recall, `sources` before tokens, tool-list filtering, run
  log). Yes and needs judgment → model, traced and bounded. Applied to deep search: harness
  owns plan-before-retrieval and the 3–6 shape, model owns the sub-questions, a short plan
  is sent back with bounded retries then 502. Not padded, not run.
- **The backend is layers; a feature is a vertical slice.** Transport (`index.ts`, and
  `worker.ts` as a second entry point) → orchestration (`loop.ts`) → one repository per
  collection → adapters → infrastructure; imports point down only. Three questions per
  feature: stores something? reachable over HTTP? happens inside a run, and does the model
  trigger it? Known compromise: `loop.ts` calls `send(res)` directly.
- **`mode` is "where to look"**, distinct from `depth`. `web` and `docs` are user-set
  boundaries the harness enforces by filtering the `tools` array passed to
  `messages.create`; the array is the menu and the harness writes it per request. `auto` is
  the only mode where the model chooses, so it is the only one the bench checks for a
  `reason`. The agent parses `mode` today and ignores it.
- First call to a new provider pays a TLS handshake (1.85 s cold → 0.44 s warm), like the
  Mongo warm-up last session.

## Open questions and next steps
- Dedupe on save is prompt-only; a similarity check before insert was not discussed.
- Phase 0 in `auto` with a `spaceId`: recommendation is to skip the web pre-search and let
  the model make the first call; the alternative pre-runs both tools. Decide with bench p95.
- `docs` without `spaceId` → 400 before the stream opens; `auto` without one collapses to `web`.
- Kill the OpenAI key once and confirm the 502 path.
- Next: the gateway (Part 2), then Spaces + worker with today's file map (`spaces.ts`,
  `documents.ts`, `retrieval.ts`, `ingest.ts` new; `index.ts`, `loop.ts`, `tools.ts`,
  `worker.ts` changed).

**ADR candidates:** recall as a harness step, save as a model tool; embedding failures are
provider errors; native fetch for every provider, no SDK on the request path; the `tools`
array filtered per request as the enforcement point for `mode` and `depth`.
