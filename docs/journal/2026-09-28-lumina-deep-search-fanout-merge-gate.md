# 2026-09-28 — LUMINA: deep search fan-out, merged citations, `depth` wired through, the spend gate, and the structured answer

## Goal
Finish deep search's machinery (SPEC §5.5, build order step 10): research each sub-question,
merge into one citation numbering, report the right gear, and gate the spend. I was short on
time, so Claude gave the design answers and complete code blocks, I applied every edit, and
Claude ran the typecheck, the live runs and the commits.

## Context
- The planner (`253bd49`) streamed `plan` first, but a deep run then fell through to ordinary
  quick research, and `index.ts` hard-coded `depth: 'quick'` in three places.
- `check.mjs` A3 counts the longest same-tool streak in `toolCalls` in push order
  (`quality/check.mjs:76`), cap 4. The bench's attribution check requires `subQuestion` only on
  `web_search`, `fetch_page`, `search_documents` (`bench.mjs:612`).
- Last session's journal entry and its index line are still uncommitted.

## What was done
Seven commits, `7795892`..`5f4c97d` (four code, three progress).

- **`7795892` fan-out** (`loop.ts`, `env.ts`, `.env.example`): phase 0+1 became
  `researchOne(r: Research)`; quick is one research, deep one per sub-question. Caps pick the deep
  envelope. `callTool(name, input, reason?, research?)` tags the trace. Each research gets a share
  of the calls left, `floor((maxCalls − step) / n)`, checked at turn start and inside the turn.
  `DEEP_CONCURRENCY` lanes (default 3), a `stopped` flag, and `Promise.allSettled`. The run log
  is regrouped per sub-question in plan order.
- **`8b69ae5` merge**: one `merged: {source, body}[]` list feeds both the `sources` event and the
  answer prompt. `urlKey()` for web, chunk id for documents, `rrf` per research.
- **`ccd35dc` depth**: `const depth = body.data.depth` feeds the run log, the `requests` row,
  `done.depth`/`done.subQuestions`, and the stored message's plan; `LoopResult` returns `plan`.
- **`fbcc84e` spend gate**: new `spend.ts` `reserveDeep()`. `429 {error, status, resetsAt,
  requestId}` + `Retry-After`, released in a `finally` after `record()`.

Verified, one run each:

| run | calls | sources | latency / TTFT | cost |
|---|---|---|---|---|
| deep, sequential, 4 sub-q | 20/24 | 14 | 35 s / 25 s | $0.13 |
| deep, forced 6 sub-q (share 3) | 20/24, 3 each, 11 refused | 12 | 44 s / 38 s | $0.15 |
| deep, 3 lanes, 4 sub-q | 21/24 | — | 23.8 s / 14.7 s | $0.145 |
| deep, RAG question, merged | 16 fetches | **13** (2 URLs deduped) | 16.7 s | $0.12 |

`check.mjs` on the lanes run plus a quick run: C1, A1–A3, B1–B3 ✓. Depth: `done` deep/4, run log
deep, `/stats.deepToday` 0 → 1, plan stored; quick still `quick`/0. Gate at `DEEP_DAILY_CAP=1`:
deep 200 → deep 429 → quick 200; **3 concurrent deep → one 200, two 429**. The refused request
left no user turn.

## Decisions
- **`recall_memory` once per run.** Memory is about the user; per sub-question it would cost N
  embeds and N identical steps.
- **No `save_memory` in sub-question research.** N sub-questions would save one fact N times.
  Price: a deep question that also states a preference does not save it.
- **An even budget share per sub-question.** Without it, a 6-way plan starves sub-questions 5–6
  (2 + 6×5 = 32 > 24). The in-turn check also closed a quick overshoot: a turn starting at step 6
  could admit 4 fetches, reaching 10 > 8.
- **Regroup the run log for A3, keep the trace interleaved.** A3 guards one line of reasoning;
  parallel lanes produced `fetch_page` ×8 in the live trace. No alternative was discussed.
- **`DEEP_CONCURRENCY` default 3**: *rationale not discussed*.
- **Documents dedupe on chunk id, not SPEC's docId+locator.** A long page is several chunks;
  merged under one number, the snippet matches neither verbatim. The bench's `distinctSources`
  counts same-page chunks once anyway.
- **The first research in plan order owns a duplicate**, because the planner puts the most
  important sub-question first.
- **`depth` comes from the request.** No upgrade, and a failed plan throws, so the error path logs
  `deep` too and a failed deep run counts toward the cap.
- **The plan is stored in Mongo only.** `ThreadMessage` in the GET contract has no field for it.
- **An in-process reservation, not a Mongo one.** DESIGN runs one agent process. A second machine
  would need the reservation in Mongo; noted in `spend.ts`.
- **Split `loop.ts` across two commits** so the merge and the depth wiring each stand alone.

## Dead ends
- **Claude's snippets contained placeholder comments** (`// ...names + output exactly as
  before...`, a `while` body described rather than written, a missing fan-out tail). Pasted
  literally, they gave `output`/`pages` not in scope. After that, Claude gave complete blocks.
- **`newResearch(s.question, s.i)` typechecked.** `s.i` landed in the new `budget` slot; only the
  quick half `newResearch(query)` errored.
- **`let terminated: Terminated = 'done'` narrowed to `'done'`** once the `'cap'` assignment moved
  into `researchOne`, so `terminated === 'cap'` became TS2367. The fix is `'done' as Terminated`.
- **Claude's check script reported `DANGLING`** because zsh does not word-split `$CITED`. The
  answer was fine.

## Learnings
- **The first deep run had no duplicates** (15 fetches → 15 sources). A test that cannot fail
  proves nothing; the overlap-prone RAG question was needed.
- **Every deep run before today was logged as `quick`.** A gate counting `requests` would never
  have fired.
- **Count-then-run is racy when the row is written at the end.** The bench probes sequentially
  (`bench.mjs:695`) and would not have caught it.

## Open questions and next steps
- 3 of 16 calls in the RAG run re-fetched a page another sub-question had. A run-level fetched
  map in `dispatch` would save that budget. Proposed, deferred: nothing grades it, and the ratio
  looks comfortable (12–15 deep sources vs quick's 2, one run each).
- A docs-only deep run can fail A3 (3 `search_documents` per sub-question back to back). Fix, or
  a bonus-rule candidate.
- An error run's log keeps completion order. Acceptable, since it belongs in `runs/failing/`.
- Next: the structured answer (the answer model still gets quick's 3–6-sentence prompt and
  `max_tokens` 1024), then a bench run for the 2× ratio, then the gateway.

**ADR candidates:** deep sub-questions get even shares of the tool budget, enforced inside the
turn; the run log is ordered per sub-question while the trace keeps real order; document sources
dedupe on chunk id rather than docId+locator; the deep spend gate reserves in-process before
counting, released only after the requests row is written.

---

# 2026-09-28 (later) — the structured answer, and a cut-off it exposed

## Goal
Close the two items still open on deep search, one at a time. First, the structured answer
(SPEC §5.5 Should, and what the 5-point human "deep quality" row reads). Second, confirming the
graded numbers, which needs the bench and therefore the gateway.

## Context
- Before starting I listed what was left. Every deep-search Must is built. The docs-only A3 risk
  does not affect the bench, because its deep workload uses `mode: 'web'` (`bench.mjs:546`).
- The answer model still used quick's "3 to 6 sentences" prompt and `max_tokens: 1024`.

## What was done
- **`a9e58d6`**: `DEEP_ANSWER_SYSTEM` in `loop.ts` (direct answer with a verdict → one section per
  sub-question → "What is still unknown"). Deep sources are grouped under the sub-question that
  found them. `max_tokens` is `env.deepAnswerMaxTokens` (`DEEP_ANSWER_MAX_TOKENS`, 2500), and a
  `stop_reason === 'max_tokens'` answer is logged.
- Typecheck clean and the `.env.example` line present. Verified; I ran these myself.

One run each, same question ("should a small team self-host Postgres or use a managed service?"):

| gear | latency | TTFT | cost | out tokens (run) | sources |
|---|---|---|---|---|---|
| quick | 18.3 s | 13.7 s | $0.034 | 720 | 3 cited |
| deep | 39.9 s | 26.1 s | $0.153 | 3781 | 14 |

Read side by side, deep was better, not only longer (verified, one reading). It had a verdict,
concrete figures (RDS ~$266 vs EC2 ~$98/month), a practitioner counterview, and a point quick
missed. It had numbered plain-text sections and no markdown.

## Decisions
- **Plain text, not markdown.** The provided UI renders the answer `pre-wrap` and only turns `[n]`
  into chips (`styles.css:184`, `AnswerText.tsx:18`). A `##` would show as `##`.
- **Quick keeps its prompt**, because quick's latency and cost SLAs depend on it.
- **Group sources by sub-question with the numbering untouched.** Each section knows its
  evidence, and any section may still cite any `[n]`.
- **"What is still unknown" must name specific gaps.** The rubric's sample scorecard docks a
  boilerplate one.
- **`max_tokens` is configuration, and a cut is logged, not a cap**, because the research
  finished. The value 2500: *rationale not discussed*.
- **Committed with the cut-off unresolved**, at my request. The commit message states it.

## Dead ends
- **The auto-mode safety check returned no verdict** on every Bash and subagent call for
  several turns. I ran the verification myself. The commit waited until I switched to manual
  permissions.

## Learnings
- **Read the provided UI before designing output.** The markdown answer I would have asked for
  would have rendered as symbols.
- **The grounding check cannot see a mis-described source.** The unknowns section called [7]
  (Fly.io) a "self-host is manageable" source, while section 2 correctly quoted it for the
  managed side. The snippet exists, so the check passes.

## Open questions and next steps
- **The deep answer was cut mid-sentence** ("No source g") at about 700 visible words, about
  1,000 tokens, well under 2500. The hypothesis is that thinking tokens count toward `max_tokens`
  without streaming. Proposed, unverified: the `answer cut off at max_tokens` log line and its
  `outTokens` will decide.
- Quick TTFT was 13.7 s against a 2.5 s SLA (earlier today 4.8–5.6 s). One run, cause unknown.
- `pickSnippet` returned navigation text for sources [8], [9] and [12].
- The progress file is deliberately not updated until the cut-off is fixed.
- Then item 2: the bench numbers, which need the gateway.

**ADR candidates:** the deep answer's structure is plain text because the provided UI does not
render markdown.
