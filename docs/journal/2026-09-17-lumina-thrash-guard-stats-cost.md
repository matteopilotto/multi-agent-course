# 2026-09-17 — LUMINA: the thrash guard, `/stats`, and a bill that can be checked

## Goal
Close the two items `HANDOFF.md` left ready — the A3 per-turn tool cap and `GET /stats` — then
start step 8. Step 8 never started: a cost number from the first verification run turned out to
be wrong in a way worth fixing first. Tutored build-along, answers-now mode; I pasted snippets.

## Context
- `expectations.json` sets `maxConsecutiveSameTool: 4`; a past failing run logged five
  consecutive `fetch_page`, so `quality/check.mjs` could fail on it.
- `/stats` was still a 501. The bench asserts `/stats.answers` is at least the answers its own
  run produced, and it drives several user ids.
- `benchmark/sla.json` caps a quick answer at `max_cost_per_answer_usd: 0.05`.

## What was done
Three commits, `febc539`..`810aea5`.

**A3 thrash guard** (`loop.ts`, `env.ts`, `.env.example`). `maxSameToolInARow` (default 4) caps
the blocks of *each* tool the harness executes in one turn; extras get a `tool_result` with
`is_error: true` naming the rule. Refused blocks never reach `callTool`, so they get no step
number, no `trace`, no `toolCalls` row, no bill.

**`GET /stats`** (new `stats.ts`, route, `/stats` off the 501 list). Exports `startOfUtcDay`,
`nextUtcDay` and `deepCountToday(userId)`; the last two exist for the deep spend gate.

**Per-model cost** (`sla.json`, `cost.ts`, `loop.ts`, `index.ts`). `cost_model.models` maps
model id → rates. `RunState` keeps `tokens` as the run total and gains `usage: ModelUsage`, a
split by model that only `costUsd` reads; `addUsage(model, u)` writes both.

Verified on the live agent, single runs:

| | result |
|---|---|
| guard at `MAX_SAME_TOOL_IN_A_ROW=2` | `web_search asked:3 ran:2`, `fetch_page asked:3 ran:2`; run reached `done` with `toolCalls: 5` |
| `/stats` reconciliation | one ask moved `answers` 4→5 and `costUsdToday` 0.194745→0.248477, a rise of exactly that answer's `costUsd` 0.053732 |
| cost split (`req_mu5p4ha6fy3w4k`) | Haiku 1463/291 = $0.002918, Sonnet 6666/396 = $0.025938, 0 billed searches, total $0.028856 — matches the reported figure to the cent |

## Decisions
- **The refusal is a tool error, not silence.** Every `tool_use` must be answered or the next
  request 400s, and the model needs to know why it got nothing. It cannot tell a refusal from a
  broken tool, which is fine: it only needs to know nothing came back.
- **Skipped blocks stay out of `toolCalls`.** The run log would otherwise claim work that never
  happened.
- **The cap is per turn, not across turns.** Two turns of three fetches still log six in a row.
  Stated rather than engineered around; the `pages.length >= 2` break makes it unlikely.
- **One window for `/stats`: today on a UTC boundary**, because `costUsdToday` says so and the
  deep cap's `resetsAt` must agree with it or a user reads "2 of 5 used" while the gate refuses.
- **Two sources, deliberately.** Volume and spend from `requests`, so a failed run still costs
  what it cost; latency and cache from `messages.done`, because an unfinished answer has no
  ttft. `requests: 6` against `answers: 4` is that gap, visible.
- **Counts are service-wide except `deepToday`**, which is per user because that is how the cap
  is enforced. Per-user `answers` would sit below the bench's own run and fail to reconcile.
- **An unlisted model is billed at the file's top-level (Sonnet) rate.** A pricing gap can then
  only overstate the bill.

## Dead ends
- **`git add -A` from the repo root swept 13 unrelated files into `febc539`** — the dev-journal
  skill, all six prior journal entries, `agent_loop.py`, the stray root `package-lock.json`, the
  Live Translate `.env.example` newline, `vectors.json`, and `scratch.ts`, which repo convention
  keeps untracked. `HANDOFF.md` had said explicitly to leave the last three alone. The commit
  message describes only the guard. Not yet repaired.
- **The first guard test proved nothing.** Four `fetch_page` against a cap of 4 is *at* the
  limit, so nothing was refused. Same shape as reading a retried job's `done` last session: an
  absence of failure is not evidence the mechanism works. Lowering the cap to 2 forced it.
- **The second test proved nothing either**, for a different reason: the guard is invisible by
  design — no trace, no row — so two `fetch_page` events cannot distinguish "refused a third"
  from "only asked for two". A `log.warn` in the refusal branch made it observable.
- **The first `/stats` check was two reads with no ask between them.** Identical numbers are the
  correct answer to that, and no test at all.
- **Two curl typos:** the thread id pasted where the literal `/threads` segment belongs, and
  `npm run lint` from the repo root, which has no `package.json`. `lint` exists only at the
  assignment root; `typecheck` exists in both.
- **My first estimate of the cost saving was wrong.** I predicted ~a third from the raw before
  ($0.053732) and after ($0.036771). Most of that gap was fewer tokens — the baseline was a
  follow-up carrying thread history. At equal tokens the pricing fix is worth 16.8%.

## Learnings
- **A mechanism with no instrument is not finished.** Twice in one session: the guard was silent
  until logged, the bill undecomposable until `usage` and `searchCalls` joined the `answer` line.
  The rule already existed in `embed.ts` via `brief()` — the trace and the row are the user's
  view, the log is mine.
- **The counting inside `Promise.all` is safe** because an async body runs synchronously to its
  first `await` and `.map` calls in order. No interleaving.
- **Sonnet carries 82% of input tokens and 90% of the bill.** The research model was never the
  expensive part; those 6,666 Sonnet input tokens are almost entirely the source block
  (`p.text.slice(0, 4000)` × 4 pages). Per-model pricing was correctness, not optimisation —
  **the cost lever is the source block size.** One run.
- Two quick runs came in at $0.0537 and $0.0552 against the $0.05 gate before the fix; $0.0289
  after. The gate risk was real and self-inflicted.

## Open questions and next steps
- **Repair `febc539`.** Decide whether to untrack `scratch.ts`, the root `package-lock.json`,
  `agent_loop.py` and the journal/skill files, or to accept them and say so.
- Step 8, hybrid retrieval: BM25 over `chunks_text`, RRF with the proven dense half in
  `retrieval.ts`, `search_documents`, `mode` as a harness gate, page locators, recall@5.
- The gateway (Part 2) has now slipped four sessions; 10 points plus the UI.
- Record in `DESIGN.md`: the per-turn-only cap, and that the cost lever is the source block.
- Still open: `GET /threads/:id` is not `safeParse`d; eight stale `failed` rows in the demo
  Space; `0.0.0.0/0` needs to reach the run notes on `/evals`.

**ADR candidates:** a harness gate that refuses work answers the model with an `is_error` tool
result and records nothing, since a refused call did not happen; every reported number carries a
log line that lets it be recomputed from outside; one UTC day boundary is shared by every window
and every quota in the service; cost is billed per model, with the most expensive rate as the
fallback for an unknown one.
