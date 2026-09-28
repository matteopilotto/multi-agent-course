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

---

# 2026-09-28 (evening) — the cut-off was default thinking

## Goal
Diagnose why the first structured deep answer stopped mid-sentence ("No source g") and still
reported `done`, then fix it.

## Context
The "(later)" section above left this open, with a guess that hidden thinking used the
`max_tokens` budget. The warning added in `a9e58d6` was the first evidence.

## What was done
- **The agent log** (from my terminal): `"depth":"deep","maxTokens":2500,"outTokens":2500,"msg":"answer
  cut off at max_tokens"`. It was a real `max_tokens` stop.
- **Counted the streamed text** with `countTokens`: 1,385 tokens (585 words). I compared it with
  the stored message: 4,064 characters, identical. About 1,100 billed tokens were not text,
  and none were lost in the stream. Verified.
- **Probed the model twice.** A trivial two-sentence prompt returned only a `text` block (96
  tokens). The real deep prompt, rebuilt from the saved plan and sources, returned `thinking,text`
  by default and `text` only with `thinking: { type: 'disabled' }` (1,301 vs 1,171 out tokens,
  both `end_turn`). Verified, one call each.
- **`e059fa6`**: `thinking: { type: 'disabled' }` on the answer call in `loop.ts`, both gears.
  Claude applied it at my request; typecheck clean.
- **`d22660f`**: progress file.

Re-run, one run each, same question, temporary agent on :8001:

| | TTFT before → after | cost before → after | answer |
|---|---|---|---|
| deep | 26.1 s → 12.3 s | $0.153 → $0.121 | complete, no cut-off warning, Sonnet out 1,325 |
| quick | 13.7 s → 6.8 s | $0.034 → $0.025 | complete |

The planner produced a different plan on the re-run, so the answers do not compare section by
section. Read once, the deep answer kept its verdict, its sections, and its specific unknowns.
It said plainly that sub-question 4's sources did not answer it.

## Decisions
- **Disable thinking rather than raise `max_tokens`.** Both were on the table. The harness has
  already planned, and this call only writes from sources it was given. Thinking also sits in
  front of the first token, and quick has a 2.5 s TTFT SLA.
- **Keep the 2,500 ceiling and the warning.** Without thinking, a 4-section answer needed about
  1,300 tokens, which leaves about 2× headroom, and a future cut still gets logged.

## Dead ends
- **The trivial probe pointed the wrong way.** It showed no thinking, and I briefly treated the
  hypothesis as refuted. Thinking depends on the prompt; only the real prompt settled it.
- **The first probe script failed with `ERR_MODULE_NOT_FOUND`.** It lived in `/tmp`, and Node
  resolves a bare import from the importing file's directory. The fix was to write it inside
  `backend/agent` and delete it afterwards.

## Learnings
- **Compare what was billed, what streamed, and what was stored.** That three-way check separated
  "lost in the stream" from "generated as something other than text" in two commands.
- **A model default can change the harness's contract with the provider.** Nothing in `src/`
  asked for thinking, yet it cost budget, money and TTFT.

## Open questions and next steps
- Quick TTFT is 6.8 s against 2.5 s. The rest is the research phase and Atlas latency.
- `pickSnippet` returns navigation text on some pages.
- Deep search is done as code; its SLA numbers need `bench.mjs`, which needs the gateway. Next:
  the gateway.

**ADR candidates:** the answer call runs with thinking disabled, because planning is the
harness's job and the answer's TTFT is an SLA.

# 2026-09-28 (late evening) — the gateway, and a worker that died without a word

## Goal
Build the gateway (Part 2): the browser's only way in, and the path `bench.mjs` and the deploy
both need. Then fix the worker crash the UI test exposed.

## Context
The gateway had been deferred for six sessions. The skeleton came with CORS, the request id,
pino, `/health` and static `web/dist`, and every other route returned 501. The agent already
returned its own 401, 404 and deep-cap 429.

## What was done
- **`5d1e55d`, the gateway** (`backend/gateway/src/index.ts`, `env.ts`), in seven steps. I applied
  each edit and Claude checked it:
  - `requireUser` is registered from the contract's `ROUTES` table, placed after `cors()`.
    Verified 401 / 501 / 200 / preflight 204.
  - `validate(schema)` gives a 400 with the zod message, and the parsed body replaces the raw
    one. Verified on five bad bodies.
  - `proxy('json' | 'stream')` relays the agent's answer untouched; uploads are streamed through.
    Verified 201/200/404/204 and 202, plus 400/404 relayed from the agent. A throwaway gateway
    pointed at a dead port returned a 502 and survived.
  - `askStream` handles SSE. Verified: events arrived trace ×5 → sources → token ×64 → done, and
    `runs/req_gw_test1.json` shows the request id reached the agent. A fake agent tested three
    endings: normal, dies mid-frame, and closes without `done`. All three correct.
  - A token-bucket rate limit, on ask and upload only. Verified with a throwaway gateway at
    3/min: three through, then 429 with `Retry-After: 20`; reads never limited; buckets per user;
    refilled after 21 s.
  - The UI then showed "404 Not Found": Vite reads `.env` from `web/`, so `VITE_API_URL` was
    empty and the UI was POSTing to itself. Fixed with a git-ignored `web/.env.local`.
    Afterwards I ran the full UI checklist in the browser and everything passed (my report,
    not seen by Claude).
- **`57a041c`, the worker.** An upload sat at `pending`: `tsx watch src/worker.ts` was alive with
  no child process. Claude reproduced a crash with a throwaway worker pointed at an unreachable
  Mongo. `pingDb()` swallows its failure, then the first `sweepStaleJobs()` rejects out of
  `void main()` and Node exits. My actual crash output was never captured, so this cause is
  inferred.
  - Step 1 (mine): each pass is caught and backs off, `2^n` up to a 30 s cap;
    `main().catch` → `fatal`. Verified against a real Wi-Fi outage, then a new upload reached
    `indexed` in 8 s.
  - Step 2 (Claude, at my request): a 5 s heartbeat into `workers`; `/health` reports
    `degraded` with a 200 after 15 s without a beat, and the gateway keeps the agent's own
    status. Verified: stopped → `degraded`/`down`/200, restarted → `ok`.
- **`c111ed1`, DESIGN.md**, written by Claude in my voice at my request: eleven collections,
  three pieces of in-memory state, and trade-off #4's worry, which came true.

## Decisions
- **Only whole SSE frames are relayed.** A half-written frame followed by our own `error`
  would reach the browser as broken JSON.
- **A stream that closes without `done` counts as an error.** A stream that just stops isn't
  a finished answer.
- **Rate limit on ask and upload only.** The bench counts a 429 as an error (budget 1 %), and
  both the UI and the bench poll documents.
- **Heartbeat on a timer, not once per pass.** A long job must not look dead. The known limit:
  it proves the worker is alive, not that it is progressing.
- **A dead worker gives `degraded` with a 200.** A 503 would make Fly and the bench treat the
  whole agent as down.
- **Validation forwards the parsed body.** That way the defaults are applied at the edge.
  Other alternatives were not discussed.

## Dead ends
- **The first 502 said "agent unreachable" when the gateway itself had thrown.** My `env.ts`
  edit was missing (`AbortSignal.timeout(undefined)`), and `tsx watch` never typechecks.
  The message is now "agent request failed".
- **`echo … > web/.env.local` never wrote the file.** I ran it from the wrong directory.
  Claude's `cd ../..` instruction had also broken a curl test earlier.
- **Blaming my `worker.ts` edit for the agent's death**, and then an agent restart. Both were
  falsified by touching files while a per-second liveness monitor ran.

## Learnings
- **An error message must claim only what it knows.**
- **A watcher that stays alive hides a dead process.** `concurrently -k` saw nothing.
- **Nothing lost is not the same as someone knowing.** The queue kept the job, but no one could
  see the worker was dead.

## Open questions and next steps
- **Unexplained:** the agent also had no child after the first Wi-Fi test. It didn't reproduce.
- **Open:** 202 takes ~385 ms against 300 ms (one measurement), and a quick run's wall clock was
  14.9 s against 12 s (one run).
- Commits `bde1097` and `4f7c379` came from the bench session that followed. That session isn't
  recorded here.

**ADR candidates:** relaying whole SSE frames and treating a close without `done` as an error ·
rate-limiting only the routes that spend · worker liveness by a heartbeat in Mongo, reported as
`degraded` with a 200.
