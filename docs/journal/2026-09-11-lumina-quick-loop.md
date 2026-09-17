# 2026-09-11 — LUMINA: built the quick search loop in the agent service

## Goal
LUMINA is Assignment 1 of the FDE bootcamp: a Perplexity-style answer engine with a fixed
API contract, a provided React UI, and two Express services I have to build. This session
covered TECHNICAL.md Part 1, step 1: the *quick* gear of the agent loop in `backend/agent/`.
Concretely, `POST /threads/:threadId/ask` had to stream `trace → sources → token → done` over
SSE, run real Tavily searches and page fetches chosen by the model, stay inside the quick caps
(8 tool calls, 90 s), report honestly why it stopped, and write a run log that
`quality/check.mjs` can grade. Deep search, threads, memory, RAG and the gateway were out of
scope.

I did it as a tutored build-along. I had a working Python harness from the module
(`agent_loop.py`: Anthropic loop, two stubbed tools, dispatch dict), and the idea was to port
that mental model to TypeScript, which I had not written before. The tutor supplied code
snippets with Python-to-TypeScript notes; I pasted them, ran them, and read the output. Each
step ended with a `curl -N` against the agent service directly, no browser and no gateway.

## Context
- Assignment root: `modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/`,
  branch `fde_cohort2`. Node 20 npm workspace; the agent service is Express 4 run with
  `tsx watch`; the wire format is zod schemas in `packages/contract/src/` (`sse.ts`,
  `http.ts`, `db.ts`). The scaffold's `src/index.ts` had `/health` implemented and a 501 for
  every other route, registered from the contract's `ROUTES` list.
- `.env` and an Atlas M0 cluster with the three search indexes were set up the day before.
  `env.ts` reads `.env` from two directories above `process.cwd()`, and `secrets` holds the
  keys separately from `env` so they are never logged.
- Added `@anthropic-ai/sdk` ^0.124 to `backend/agent`. Tavily is called over plain HTTPS with
  Node's global `fetch` (`/search` and `/extract`), bearer-token auth, no Tavily SDK.
- Prices come from `benchmark/sla.json` → `cost_model`: $3 / $15 per million tokens in / out,
  $0.008 per search call. The bench uses the same file, so `done.costUsd` and the grader
  cannot drift.

## What was done
Thirteen commits on `fde_cohort2`, one per step, `0234a60` through `372a9b6`. In order:

1. **`DESIGN.md` committed first** (`0234a60`) at my request, since it was written before the
   build. `DESIGN_NOTES.md` is personal and stays local: it is listed in
   `.git/info/exclude`, which behaves like `.gitignore` but is never committed.
2. **SSE transport** (`4d7e916`), `src/sse.ts`. `openStream` sets `Content-Type:
   text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
   `X-Accel-Buffering: no`, and calls `res.flushHeaders()`. `send(res, event, data)` writes
   one `event:` / `data:` frame. The route first played a fake stream with a one-second
   `sleep` between two tokens; `curl -N` showed the pause, which proved nothing was
   buffering. The 501 loop in `index.ts` needed the ask path added to its `continue` so the
   scaffold stopped registering a competing handler.
3. **Tools** (`1cde2f9`), `src/tools.ts`. `webSearch(query)` returns up to five
   `{title, url, snippet}`; `fetchPage(url)` returns extracted page text, capped. Tool
   schemas (`TOOL_SCHEMAS`) live next to the functions, same split as `TOOLS` vs
   `TOOL_FUNCTIONS` in the Python file: the schemas cross the network, the functions stay
   local. Tested from a throwaway `src/scratch.ts`.
4. **The loop, wired** (`2a112b4`, `42814ff`), `src/loop.ts` `runQuickLoop`. Direct port of
   the Python `while True`: call the model with tools, `break` on anything but
   `stop_reason: "tool_use"`, dispatch each `tool_use` block, append `tool_result`s. New
   versus the Python: a `try/catch` around dispatch that feeds the exception back as an
   `is_error` result and emits a `trace` step with `ok: false` and the message, instead of
   crashing. The body is parsed with `AskBody.safeParse` → 400.
5. **Caps** (`2d8766a`). The cap is checked before every model call. Over cap, the model gets
   one last call with `tool_choice: { type: "none" }` plus a text note saying the budget ran
   out, and the run reports `terminated: "cap"`. Verified with `MAX_TOOL_CALLS=2`: two
   steps, then an answer whose last paragraph listed what it could not verify.
6. **Two-phase loop** (`d3985e3`). Research phase with tools on; then `sources` is sent;
   then an answer phase with **no `tools` argument at all**, whose system prompt contains
   only the fetched pages numbered `[1]..[n]`. The answer streams through
   `client.messages.stream` and each `text` delta becomes one `token` frame. `pickSnippet`
   picks the fetched paragraph with the most query terms, verbatim, because the bench
   re-fetches the URL and looks for the snippet in it.
7. **Prettier** (`dfddca9`, `672d543`). `.prettierrc` matching the scaffold, then one
   format-only commit so future saves produce empty diffs.
8. **Real `done` numbers and fail-loud** (`8dc7aef`). `src/cost.ts` reads the sla cost
   model. `ProviderError` in `tools.ts` marks Tavily 5xx or any `/search` rejection; the
   loop traces it `ok: false` *and then* rethrows, and the route's `try/catch` sends an
   `error` SSE frame with 502. A single unreadable page stays a plain `Error` the model
   routes around. `ttftMs` is the first streamed delta; tokens are summed across every
   model call. Verified with `TAVILY_API_KEY=bad`.
9. **Run log** (`82872c3`), `src/runlog.ts`. `RunLog.parse` validates against the contract
   before `writeFileSync` to `runs/<requestId>.json`. The route owns a `RunState`
   (`toolCalls`, `tokens`) that the loop fills, so the log is written on the error path too
   with `terminated: "error"`. Request id reused from `X-Request-Id` when present.
   `node quality/check.mjs .` exits 1 with only the P2 warning, which the spec says is
   expected until the cohort fills rule precedents.
10. **Latency pass** (`372a9b6`), details under Decisions.

## Decisions
- **Answer phase has no tools, rather than one loop with a "cite only fetched pages"
  prompt.** The very first real run answered from five search snippets without calling
  `fetch_page` once, despite a prompt saying to fetch. A stronger prompt fixed that run but
  the capped run still admitted leaning on snippets. Removing `tools` from the answer call
  makes snippet-only synthesis impossible instead of discouraged. Same principle as the
  spec's note on `plan_research`: filter the tool list, do not ask nicely.
- **The harness runs the first search, on the question as typed.** Timing showed the
  model's first turn spent 1.2–1.4 s turning "What is Tavily?" into "What is Tavily". Now
  phase 0 calls `web_search` directly and the model's first message is the question plus
  the results, so its first decision is which pages to read. The trace step carries
  `reason: "harness pre-search: the question as typed"` so a reader can tell a harness
  decision from a model one. `web_search` stays in the tool list for follow-ups like "and
  what does the market say?" once threads exist.
- **Cheaper model for research, Sonnet for the answer.** `LLM_MODEL_RESEARCH` (default
  `claude-haiku-4-5-20251001`) for page picking; `LLM_MODEL` for the answer, which is what
  `done` and `/health` report. The tutor's caveat, which I accepted: a weaker page picker
  can pass the grounding check while citing worse sources, so this has to be checked by
  reading traces side by side, and it must not be used for `plan_research` or the answer.
- **Exit research after two fetched pages without asking the model.** The READY turn was a
  full round trip whose only output was the word READY. `if (pages.length >= 2) break`
  after the tool results are appended. READY stays in the prompt as the fallback when
  fetches fail. Trade-off: on quick, the harness decides "enough" by a count.
- **Compact search results.** `web_search` now returns `n. title / url / 160-char snippet`
  instead of raw JSON; the second research turn dropped from ~4,000 to ~1,200 input tokens.
  Page text capped at 8k chars in tool results and 4k in the answer prompt.
- **Parallel fetches** with `Promise.all` over the tool blocks of one turn, since fetches
  are independent. Step numbers stay ordered because `step += 1` runs before the first
  `await`.
- **OpenAI model (`gpt-5.6-luna`) for research** was raised and deferred. `loop.ts` is
  written against Anthropic message shapes (`tool_use` / `tool_result`, `input_schema`),
  so it needs a provider interface first. Decision: try Haiku now (one env line), build the
  interface as its own step after the cache if still wanted.
- **`.prettierrc` matching the scaffold rather than Prettier defaults.** Consistency within
  the repo beats the popular style. My editor was saving 4-space, double-quote files, which
  turned 18-line changes into 140-line diffs.

## Dead ends
- **Tavily 401 from `scratch.ts`.** Running the script from the repo root gave an empty key.
  `env.ts` resolves `.env` relative to `process.cwd()`, not the file, so from the root it
  looked in `/Users/matteo/Documents/.env`. Run from `backend/agent`.
- **First real answer had no `fetch_page` calls.** Looked correct, would have been scored
  down under §5.2 "snippet-only synthesis". Fixed by prompt, then structurally (above).
- **Whole-file reformats on save**, three times, before the `.prettierrc` landed.
- **Parallel fetches did not move ttft** on a single run (4.0 s → 4.4 s). Provider tail
  latency on the research turn swamped a 0.35 s saving. Not a regression; one run is not a
  p95.

## Learnings
- Express 4 does not catch errors thrown from `async` handlers, and once `flushHeaders`
  has sent the 200, a status code can no longer carry a failure. The route's `try/catch`
  plus an `error` SSE frame is the only path a mid-stream provider failure has to the
  caller. Without it the connection just hangs.
- The contract's zod schemas enforce nothing on their own. `ROUTES` lists method, path and
  auth only; each boundary has to call `safeParse`. There is no FastAPI-style automatic
  validation in Express.
- `stop_reason` is why one *generation* paused. After `end_turn` there is no model sitting
  there to change its mind; the model decides within a turn, the harness decides whether
  there is another turn. Reconsideration is a harness feature and costs a call.
- `tool_choice: none` keeps the tool definitions in the prompt but forbids their use.
  Removing `tools` entirely is one notch stronger.
- `...(cond ? { key } : {})` leaves the key absent rather than `undefined`, which matters
  for API payloads and for the contract's "no `error` field on ok steps".
- Timeline reconstruction from three sources: pino `time` on the `model call` log lines,
  `done.ttftMs`, and the run log's per-tool `ms`. Subtracting adjacent timestamps and the
  call durations gave the tool times; those matched the measured `ms` to within 2 ms
  (search 2961 inferred vs 2960 measured; fetches 864 vs 432 + 432). Gaps in a timeline
  are as informative as the events.
- `ls -t runs/ | head -1` to find the newest run log; `cat runs/*.json | head` truncates.

## Numbers (same question, "What is Tavily?", single runs each)
| version | ttft | latency | cost | in tokens |
|---|---|---|---|---|
| first working loop | 8.5 s | 12.4 s | $0.070 | 17,863 |
| Haiku research, fewer turns, smaller pages | 4.8 s | 8.4 s | $0.035 | 6,460 |
| pre-search, compact results | 4.0 s | 7.8 s | $0.033 | 5,634 |
| + parallel fetches | 4.4 s | 7.9 s | $0.033 | 5,634 |

SLA targets (`benchmark/sla.json`): ttft p95 ≤ 2.5 s (**still missed**), answer p95 ≤ 12 s,
quick cost mean ≤ $0.05. Input tokens were three quarters of the cost. Note `cost.ts`
prices every token at the Sonnet rate, so cost is overstated once Haiku is in the loop.

Where the remaining 4 s goes (one timed run): pre-search ~0.4 s, Haiku research turn
1.2–2.2 s (varies run to run), two fetches ~0.75 s in parallel, Sonnet first delta ~0.65 s.

## Open questions and next steps
- **Design decision, not yet made:** keep the model choosing pages (ttft is floored by one
  model round trip plus a fetch) or have the harness fetch the top two results and skip the
  research turn on quick entirely (~1.5 s ttft, but quick becomes a fixed pipeline and
  "the agent chooses its tools" only holds for deep). Agreed to let `bench.mjs` p95 over the
  workload decide. Whichever wins belongs in DESIGN.md's trade-offs.
- Next in TECHNICAL.md order: search cache (in-process LRU over the `searchCache` TTL
  collection, `searchCached` in `done`); threads and messages, since the route still ignores
  `threadId`; memory; then the gateway.
- Housekeeping: add `LLM_MODEL_RESEARCH` to `.env.example`; decide whether the
  `phase: research / answer` timing log lines stay; price tokens per model in `cost.ts`;
  delete or exclude `scratch.ts`.

**ADR candidates:** two-phase loop with a tool-less answer phase; harness pre-search on the
question as typed; per-phase model routing (cheap research, strong answer).
