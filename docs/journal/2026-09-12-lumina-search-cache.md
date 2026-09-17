# 2026-09-12 — LUMINA: two-tier search cache in front of `web_search`

## Goal
TECHNICAL.md Part 1, step 2: cache Tavily search results in two tiers, an in-process LRU
over a MongoDB `searchCache` collection with a TTL index, keyed by a SHA-256 of the
normalized query plus the provider, and make `done.searchCached` true only when every search
in the request was a hit. The bench requires a ≥ 50 % hit rate on a workload that is half
repeats, and `searchCached` is what it counts. The spec's *Should*, bypassing the cache for
time-sensitive queries, was in scope too.

Same format as the last session, a tutored build-along, with one difference: I was short on
time, so I asked for the answers and the snippets up front instead of working through the
Socratic questions, and reviewed the reasoning afterwards. I still pasted, ran, and reported
every step.

## Context
- `scripts/indexes.json` already declared `searchCache_ttl` on `expiresAt` with
  `expireAfterSeconds: 0`, and the index existed on Atlas (verified with
  `create-indexes.mjs --status`). `env.ts` already read `SEARCH_CACHE_TTL_SECONDS` (21 600).
- The contract's `SearchCacheDoc` (`packages/contract/src/db.ts`) types `expiresAt` as
  `z.union([z.string().datetime(), z.date()])`, so both a string and a `Date` validate.
  That turned out to matter (Decisions).
- The contract's `TraceEvent` has no `cached` field; the fields are `step, tool, input, ok,
  ms, reason?, error?, subQuestion?`.

## What was done
Nine commits on `fde_cohort2`, `c68bc62` through `7c9b74a`, one per build step.

1. **Key** (`c68bc62`), `src/cache.ts`: `normalizeQuery` (trim, lowercase, collapse
   whitespace, strip trailing `?.!`) and `cacheKey` = sha256 of `normalized + "\n" + provider`.
2. **LRU** (`a6abfd5`): `SearchLru` on a `Map`, delete-and-reinsert on hit to bump recency,
   evict the first key past 500 entries, and treat an entry past `expiresAt` as a miss.
3. **Mongo tier** (`c228c85`): `readMongo` checks `expiresAt` in code; `writeMongo` does
   `replaceOne` with `upsert: true` and validates with `SearchCacheDoc.parse` first.
   Verified from `scratch.ts`: the row came back with `expiresAt` about six hours out.
4. **Wiring** (`2861595`): `cachedWebSearch` looks up LRU, then Mongo, then calls
   `webSearch`, refilling the tiers above whichever answered. Nothing in it catches.
   `loop.ts` `dispatch` calls it and pushes each hit/miss into `searchHits`.
5. **Honest reporting** (`5676ecf`): `searchHits` moved into `RunState` so the error path
   sees it; `providerSearchCalls(state)` counts misses only and feeds `costUsd`;
   `dispatch` returns `{ output, note? }` and `callTool` folds the note into the trace
   `reason`; `LoopResult.searchCached = hits.length > 0 && hits.every(Boolean)`.
6. **Warm-up** (`58c0d84`): `void pingDb().then(...)` inside `app.listen`.
7. **Bypass** (`7f2532b`): `isTimeSensitive` (today / latest / now / yesterday / this
   week|month|year, or a four-digit year ≥ current) skips both read and write, with the note
   `time-sensitive query, cache bypassed`. Also fixed a "providper" typo from step 4.
8. **Follow-ups** (`3896fda`, `7c9b74a`): `LLM_MODEL_RESEARCH` in `.env.example`; the two
   per-model-call timing lines in `loop.ts` demoted from `info` to `debug`.

Verified end to end with `curl -N` against `:8000`, same question three times:

| run | search step | `searchCached` | cost |
|---|---|---|---|
| miss, Tavily | 2 452 ms | false | $0.033 |
| LRU hit | 0 ms | true | $0.024 |
| Mongo hit after restart, before warm-up | 1 605 ms | true | $0.024 |
| Mongo hit after restart, after warm-up | 128 ms | true | $0.025 |

"latest Tavily news" twice: both bypassed, `searchCached: false` both times. Single runs, not a p95.

## Decisions
- **`expiresAt` is stored as a `Date`, not an ISO string.** Mongo's TTL sweeper only
  considers BSON dates; a string would validate against the contract, write fine, and never
  expire. The LRU keeps epoch milliseconds and converts at the boundary.
- **Both tiers check expiry in code.** The sweeper runs about once a minute, so a row can
  outlive its TTL by up to that. DESIGN.md trade-off 3 already committed to this.
- **Normalization is limited to meaning-preserving transforms.** No stemming, stopword
  removal, or word reordering: a cache that merges near-synonyms serves wrong answers.
  The provider is in the key so a `SEARCH_PROVIDER` flip cannot serve the other provider's
  rows while `/health` names the new one.
- **Cache hits and bypasses go into the trace `reason`,** not a new field, because the
  contract's `TraceEvent` has none and outbound events must match it.
- **Misses only are billed.** A hit never reached Tavily. Failed searches push nothing, so
  they count neither as a hit nor as a billed call.
- **The bypass skips the write too.** The same query would bypass the read next time, so the
  row would never be served. Accepted cost: bypassed repeats in the bench workload lower the
  hit rate a little; the spec lists the bypass as a Should and the target has room.
- **Timing lines stay, at `debug`.** Spec §10 wants one info line per answer, and the
  bench reconciles `/stats` with the log; `LOG_LEVEL=debug` brings them back for tuning.
- LRU cap of 500 entries: *rationale not discussed*.

## Dead ends
- **Two commits landed a stray file at the repo root.** To split one file into per-step
  commits the tutor staged partial versions with `git hash-object -w` and
  `git update-index --add --cacheinfo`, using a path relative to the assignment folder.
  That command takes paths relative to the repo root, so `c68bc62`/`a6abfd5` (original
  hashes) created `<root>/backend/agent/src/cache.ts`. Caught by `git diff --stat` showing
  60 deletions on a file that never existed in the working tree. Nothing was pushed (no
  upstream), so `git reset --mixed 372a9b6` and four redone commits with full paths.
- **`Cannot find name 'searchHits'`**: the declaration was mentioned in prose, not in a
  snippet. **`'startedAt' is declared but never read`**: I dropped the `ttftMs` line when
  replacing the function ending. Both fixed in a line; both are snippet-handling slips.
- **The 1.6 s Mongo "hit"** was not the lookup: `db()` opens the client lazily, so the first
  request after every restart paid the Atlas handshake inside the ttft window.

## Learnings
- A cache is a correctness decision disguised as a performance one; every rule above exists
  so it can make a request cheaper without ever making an answer wrong, and it must never
  turn an exception into an empty result.
- A JavaScript `Map` keeps insertion order, so it is an `OrderedDict`: first key is LRU,
  delete+set is `move_to_end`.
- `void promise.then(...)` for a deliberate fire-and-forget; `[a, b].filter(Boolean).join('; ')`
  to build a string from optional parts.
- The contract's `iso` accepting `Date | string` means the schema cannot catch the TTL
  mistake; only knowing how Mongo TTL works does.
- `npx tsx src/scratch.ts` from `backend/agent`; from the assignment root also worked because
  `env.ts` tries `./.env` as well as `../../.env`.

## Open questions and next steps
- Next: `threads` + `messages` (the ask route still ignores `threadId`), then memory, then the
  gateway.
- Still open from last session: model-picks-pages vs harness-fetches-top-two on quick, to be
  decided by `bench.mjs` p95; per-model token pricing in `cost.ts`; `scratch.ts` untracked.
- The LRU is per process; two agent machines would share only the Mongo tier
  (DESIGN.md already says so).

**ADR candidates:** two-tier search cache with code-side expiry checks; time-sensitive
bypass that skips read and write; cache state surfaced through the trace `reason` rather than
a contract change; provider calls billed on misses only.
