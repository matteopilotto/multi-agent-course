# 2026-09-12 — LUMINA: threads and messages, and the loop sees the thread

## Goal
TECHNICAL.md Part 1, step 3: `POST /threads`, `GET /threads`, `GET /threads/{id}`, and an
`/ask` that persists both turns and feeds the earlier turns to the model, so a follow-up like
"and how much does it cost?" resolves against the thread. Same format as the last two
sessions, a tutored build-along in answers-now mode: I was short on time, asked for the
snippets up front, pasted, ran, and reported every step. One detour where I asked for the
reasoning behind `appendMessage`'s signature.

## Context
- The ask route ignored `threadId` entirely; every question was a fresh context.
- The contract already defines `ThreadDoc` and `MessageDoc` (`packages/contract/src/db.ts`),
  `GetThreadResponse` with `createdAt` as an ISO string, and `USER_HEADER = 'x-user-id'`.
- `newId()`'s prefix union has no `msg` entry; `MessageDoc._id` is any string.
- The Mongo access pattern from `cache.ts` (`(await db()).collection<Doc>(COLLECTIONS.x)`)
  was the template for `threads.ts`.

## What was done
Five commits on `fde_cohort2`, one per step, each typechecked and linted first.

1. **`POST /threads`** (`b02b23c`), new `src/threads.ts` with `createThread` and, in
   `index.ts`, `userIdOf(req)` reading `USER_HEADER` → 401 when missing. The 501 loop skips
   the route by path *and* method so `GET /threads` stayed 501 until step 2. Verified: 201
   with a `thr_…` id, 401 without the header.
2. **The two GETs** (`44f9449`): `findThread` filters on `_id` and `userId`; `listThreads`
   newest first, limit 50, `Date → toISOString()`; `threadMessages` oldest first. Verified:
   list, empty `messages: []`, 404 on an unknown id, 404 on another user's id.
3. **Persistence** (`734ab9b`): `titleFromFirstQuery` (`updateOne` filtered on
   `title: 'New thread'`), `appendMessage(doc: Omit<MessageDoc, '_id' | 'createdAt'>)` with
   `randomUUID()`; `/ask` now does 401, 400, then the thread lookup, then `openStream`; the
   user turn is written before the loop, the assistant turn (content, sources, `answerId`,
   the `done` event as a named const) only on success. Verified: title equals the question,
   roles `user, assistant`, 3 sources, `terminated: done`, 404 on `/threads/thr_nope/ask`.
4. **History into the loop** (`e99f5d3`): `runQuickLoop(..., history = [])`;
   `historyMessages` (last 6 turns, 1 500 chars each, leading assistant turns dropped) as
   real turns in the answer phase; `historyText` (400 chars each) prepended to the research
   opening; both system prompts amended; `index.ts` reads history *before* appending the
   user turn. Verified by trace: the follow-up's model search was "Tavily pricing cost plans".
5. **What the trace exposed** (`cbf1a6f`): follow-ups skip the phase-0 harness pre-search;
   `callTool` captures `thisStep` at entry.

Measured on "and how much does it cost?" after "What is Tavily?" (single runs, not a p95):

| | step 1 | ttft | cost |
|---|---|---|---|
| after step 4 | pre-search on the literal words, 2 015 ms | 8 597 ms | $0.047 |
| after step 5 | model's own search, full topic | 6 766 ms | $0.036 |

The fresh question on that thread was a cache hit: ttft 3 542 ms, $0.025.

Not verified: the follow-up's answer *text*. I pasted only trace and `done` events, so
whether it talks about Tavily's pricing specifically was never read.

## Decisions
- **The 404 lookup runs before `openStream`.** Once SSE headers are out, a status code can no
  longer carry the failure; the same reason the `error` frame exists.
- **The user turn is written before the loop runs**, so a failed run still leaves the question
  in the thread. The assistant turn is written only on success, including `terminated: cap`,
  because an error has no answer text to store.
- **The agent checks `x-user-id` itself** even though the gateway will: every row needs an owner.
- **Thread lookups filter on `userId` too**, so another user's thread is a 404, not a leak.
- **`appendMessage` owns the id and timestamp** via `Omit`, so no call site can forget or
  differ. `randomUUID()` because `newId` has no message prefix and the contract only wants a string.
- **Title rename filters on `title: 'New thread'`**, so a user-renamed thread is left alone with
  no read-then-write race.
- **History is read before the current turn is appended**, or the question appears twice.
- **Earlier `[n]` numbers are declared dead in the answer prompt**: they point at sources no
  longer listed, and reuse would be a fabricated citation.
- **Follow-ups skip the harness pre-search.** The words as typed are not a query; the shortcut
  cost 2 s, a billed provider call, and a junk cache row. Alternatives (e.g. a cheap query
  rewrite before the pre-search) were not discussed.
- History bounds (6 turns, 1 500 / 400 chars), the list limit of 50, and dropping leading
  assistant turns rather than merging: *rationale not discussed* beyond "must not eat the
  token budget" and "the API wants the first turn to be the user's".

## Dead ends
- **Both parallel fetches reported `step: 4`; there was no step 3.** `step += 1` ran for both
  before either sent its trace, and `send` read the shared counter afterwards. Fixed by
  capturing the number at entry. The trace is what caught it; nothing else would have.
- **Phase 0 was right for fresh questions and wrong for follow-ups.** Not a failed attempt,
  but the first design of step 4 kept it unconditional and the trace showed the waste.

## Learnings
- `Omit<T, K>` as a division of labour: the function fills in what the database needs, the
  caller supplies what the conversation needs, and the compiler polices the line. Object
  literals are checked strictly, so a missing or extra key fails at compile time.
- zod's `.default([])` makes `sources` *required* on the inferred output type, which is why
  the user turn must pass `sources: []`.
- A shared counter read after an `await` is a concurrency bug even in single-threaded Node.
- The harness can tell fresh from follow-up from `history.length`, so a shortcut can be
  conditional instead of always-on.

## Open questions and next steps
- The plain indexes from SPEC §8 (`{userId, createdAt}` on `threads`, `{threadId, createdAt}`
  on `messages`) are not created; check whether `scripts/create-indexes.mjs` covers them.
- `GET /threads/:id` is not `safeParse`d against `GetThreadResponse` on the way out.
- Follow-up ttft (6.8 s) is still about double a cached fresh question, because of the Haiku
  research turn before the first search. Revisit only if `bench.mjs` p95 misses.
- Read a follow-up's answer text end to end at least once.
- Next: memory (`save_memory` / `recall_memory` over the `memories` vector index,
  `GET /memory`, `DELETE /memory/:id`), then the gateway.

**ADR candidates:** thread lookups scoped by user (404 over 403); user turn persisted before
the run, assistant turn only after; history bounded and earlier citation numbers declared
dead; harness pre-search only on a fresh question.
