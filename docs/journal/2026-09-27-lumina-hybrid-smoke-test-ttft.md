# 2026-09-27 — LUMINA: hybrid retrieval tested through `/ask`, and where TTFT goes

## Goal
Pick up after ten days away: step 8 (hybrid retrieval) was built in the third 2026-09-17 session
but never committed or run end to end. Test it through the real endpoint, fix what the test
finds, commit, then find out why TTFT runs 9–23 s against a 2.5 s p95. I was short on time, so
Claude wrote the fixes and ran the tests; I asked for each step.

## Context
- The step 8 build session has no journal entry. What it did is in `progress/learner-progress.md`
  and now in `03a0e68`. Its recall numbers came from `scratch.ts` calling retrieval directly, with
  no model and no HTTP.
- `benchmark/sla.json`: `ttft_p95_ms: 2500`, `answer_p95_ms: 12000`.

## What was done
Five commits, `cfd742f`..`d39dfdd`.

- **`cfd742f`**: the worker fix from 09-17. A job that fails for good deletes its chunks.
- **`03a0e68`**: step 8 plus two fixes found today. `search_documents` output now labels passages
  with filename and page/heading instead of `doc_…` ids. The harness now ends the document side
  after `MAX_DOC_SEARCHES` (3, the pre-search included) or when a search returns only chunks
  already seen (`seenChunks`, `staleDocSearch` in `loop.ts`).
- **`843a46a`**: docs mode skips the research turn when the pre-search already filled top-k
  (`docsFull()`, `skipResearch`).
- **`d2e1d51`, `d39dfdd`**: progress file, and the 09-17 thrash-guard journal that had been left
  untracked.

Verified against the "gold corpus" Space, one run each unless stated:

| test | result |
|---|---|
| `docs`, "default k1?" | "1.2 [1]", source `retrieval-basics.pdf` `{page:1}`, snippet contains the anchor |
| `web` + `spaceId` | no `search_documents` in the trace; web sources only |
| foreign `spaceId` | `404` before the stream opens |
| `auto`, off-corpus "thrash loop" | before the fix: `cap`, 8 calls, $0.034. After: `done`, 5 calls, $0.014 |
| `auto`, "default k1?" | web and doc sources in one numbering; the doc source is cited |
| docs research skip, 3 questions | all skipped; pre-search end → `sources` went from 1.73 s to 0.19–0.27 s |

## Decisions
- **What ends a docs-only research phase.** The options were a count, the model saying READY,
  and whether new searches keep returning the same passages. The model's READY was ruled out:
  the failing run showed the model will not stop on its own. I chose novelty as the main signal
  and a count as the backstop, because on a 30-chunk corpus a rephrasing always turns up one new
  chunk. In the verified run the count is what fired.
- **Filenames, not ids, in tool output.** The model called `fetch_page` on a `doc_…` id.
- **Skip only in docs mode.** In web mode the research turn still decides which pages to fetch.
  Accepted cost: `save_memory` cannot be reached on the skipped path. Follow-ups still get a
  research turn, because they have no pre-search.

## Dead ends
- **The first auto-mode timings (9–23 s) were inflated.** I ran two asks concurrently. Sequential
  runs gave docs 4.6 s, web 6.9 s, auto 11.3 s.
- **The research skip does not show in total TTFT yet.** After the change, docs TTFT was 6.0–8.1 s,
  because Atlas slowed down within the hour: a standalone vector query went from 0.35–0.55 s to
  0.8–3.4 s. The saving shows only in the pre-search → `sources` gap.
- **Claude predicted the "thrash loop" rerun would use 4 tool calls or fewer.** It used 5.
  `recall_memory` and the `web_search` pre-search count toward the total.
- **`03a0e68` includes `scratch.ts` changes.** The 09-17 entry says repo convention keeps it
  untracked; it has been tracked since `febc539`. Not repaired.

## Learnings
- **TTFT is a sum of phases that run one after another.** In order: about 0.5 s of Atlas round
  trips before the first tool; the pre-search (1.6–5.4 s); at least one Haiku research turn
  (1.5–2.5 s); any tools that turn asks for; then 0.8–1.4 s to the answer's first token. Even with
  no variance the total is about 3.3 s, so the 2.5 s target cannot be met with this design.
- **Atlas M0 from the laptop is the biggest variable.** A warm doc search is about 0.8 s (embed
  about 250 ms, then vector and text in parallel), but a single vector query reached 3.4 s.
- The query is embedded twice, once for `recall_memory` and once for `search_documents`.
- **One Atlas timeout killed the worker.** `PoolClearedOnNetworkError` escaped `main()` in
  `worker.ts`. `runOne` catches its own errors, but the poll loop around it does not. This is the
  same class of bug as the `db.ts` connect bug from 09-16.

## Open questions and next steps
- **Worker poll loop:** try/catch with backoff. Proposed, not applied.
- **TTFT levers, not yet built:** deploy the agent in the Atlas region; warm the search indexes at
  startup; embed once per run; have the harness fetch top web results itself rather than asking
  Haiku (needs a design discussion first).
- Then deep search, then the gateway (slipped five sessions).
- Decide what to do about `scratch.ts` being tracked.

**ADR candidates:** the harness, not the model, ends a research phase, using novelty with a
count as backstop; the router mode is enforced by which tool schemas are sent, not by the prompt;
a research turn is skipped when the pre-search already answers what it would decide.
