# 2026-09-27 — LUMINA: the deep-search planner, and an async route that killed the agent

## Goal
Start deep search (SPEC §5.5, build order steps 9–10). This session covered part one: `plan_research`
and the `plan` event, streamed before any retrieval, then reading three plans before building the
fan-out on top of them. I was short on time, so Claude answered the design questions, and from the
`safe` fix on it applied the edits and ran the tests at my request.

## Context
- `env.ts` already had `deepSubQuestionsMin/Max` (3–6), `deepDailyCap`, and the deep caps.
  `stats.ts` already had `deepCountToday`. The contract's `PlanEvent` allows 2–8 sub-questions.
- `sla.json`: `deep_plan_p95_ms: 4000`. The bench starts that clock when the request is sent
  (`benchmark/lib.mjs:78`), so everything before the planner counts.

## What was done
Three commits, `bdacb0b`..`86f9116`.

- **`bdacb0b`**: every async route goes through `safe()`, and the error middleware passes the error
  to `next(err)` when `res.headersSent`. Verified by typecheck only; I did not force a failure to
  see the 502.
- **`253bd49`**: `planner.ts` with `planResearch()`, a forced `tool_choice` call on
  `LLM_MODEL_PLANNER` (Haiku by default). In `loop.ts`, a deep-only block before phase 0 sends
  `plan`, then a `plan_research` trace step. `/ask` writes the user turn and thread title in the
  background and `await saved` before `done`. Added `.env.example` `LLM_MODEL_PLANNER`.
- **`86f9116`**: progress file.

Verified, one run each unless stated:

| run | planner ms | request → `plan` | sub-questions |
|---|---|---|---|
| Sonnet, first prompt | 6876 | — | 6, one pinned to "in 2024" |
| Sonnet, dated + short prompt | 5220 | — | 6, distinct kinds of page |
| Haiku | 3523 | — | 5, two misspelled ("differentstack") |
| Haiku + background writes, 2008 question | 3443 | 3672 | 4 |
| Haiku + background writes, Atlas question | ≈3.3 s | ≈3512 | 4 |

`plan` was the first event on every run. After the background-write change, the thread showed its
title and `["user","assistant"]` in order. Deep runs still fall through to quick research, and
`done.depth` still says `"quick"`.

## Decisions
- **The harness calls the planner, not the model.** On a deep run the plan may not be skipped and
  must come before retrieval; a tool the model picks could come second. The schema lives in
  `planner.ts`, never in `TOOL_SCHEMAS`, so no research turn can reach it (R2).
- **Plan before phase 0, nothing in parallel.** Otherwise the recall and pre-search trace events
  could reach the wire before `plan`.
- **The harness numbers `i` and enforces min/max.** `minItems`/`maxItems` in the schema guide the
  model and do not bind it. A plan below the minimum throws; the server never downgrades to quick.
- **Haiku over Sonnet for the planner.** Sonnet plans more varied questions; Haiku is the only one
  near the budget. A missed SLA costs the whole bench row, while a slightly worse plan costs part
  of the 5 human-graded points. Fallback if quality drops: Sonnet with max 5. Proposed, not tried.
- **The top-level plan `reason` stays optional.** The harness should not make up a reason.
- **Two commits.** The crash fix is not about deep search.

## Dead ends
- **Port 8000 was held by a stale `tsx src/index.ts`** (no watch) from an earlier Claude shell. It
  would have served code without the planner.
- **My typing of `safe` took three tries.** A plain `express.Request` lost the route params
  (`string | undefined` under `noUncheckedIndexedAccess`). A bare `<P>` widened to `unknown`.
  Inferring `P` from the return type never works through a wrapper. The fix: explicit
  `safe<{ threadId: string }>`. Claude twice said "compiles clean" on scratch files while
  `index.ts` still had bracket errors; with syntax errors, `tsc` does no type checking, so those
  checks proved nothing.
- **Bracket slips when wrapping `/ask`**: `})` on an inner `if`, `});` at the end. Fifth
  occurrence of this pattern.

## Learnings
- **Express 4 does not catch rejected async handlers.** One slow M0 connect
  (`MongoServerSelectionError`, 5 s) in `POST /threads` was an unhandled rejection, and Node 22
  exited. Atlas itself was fine: same IP, TLS ok, connects ranged from 1.7 s to 12 s.
- **A promise you await later needs `.catch(() => {})` now**, or a rejection in between kills the
  process. `await saved` still throws.
- **Without a date, the model assumes one.** The fix is `planSystem()` built per call, not a
  module constant that freezes at startup.
- Shortening the output cut Sonnet from 6.9 s to 5.2 s. Output tokens are most of the planner's
  time.

## Open questions and next steps
- Request → plan is 3.5–3.7 s over two runs, direct to the agent. The gateway hop is not measured;
  only a bench p95 decides.
- Haiku plans overlap (2008: "root causes" vs "subprime"). If the step 8 source ratio falls short
  of 2×, fix this first.
- Next: step 3, the fan-out; then merge, structured answer, `depth` through the route, the spend
  gate, the ratio check; then the gateway.
- Still open from last session: try/catch in the worker poll loop.

**ADR candidates:** the deep-search planner is a harness step whose schema no model turn can see;
the planner model is chosen for the time-to-plan SLA rather than plan quality; async routes are
wrapped so a rejection is a 502, never a process exit.
