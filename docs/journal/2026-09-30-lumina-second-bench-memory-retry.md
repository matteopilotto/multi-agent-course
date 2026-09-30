# 2026-09-30 — LUMINA: the second full bench, a memory write the speed-up skipped, and one retry for OpenAI

## Goal
Run the full bench once on `e3287b8`, the code with the cache, TTFT, crash and history-read fixes,
and compare it with the first run. Then work through the misses one at a time, measuring before
changing anything, and never touching `benchmark/` or `sla.json`.

## Context
- The session started from a handoff at the end of 2026-09-29 and ran into 2026-09-30. Claude did
  the edits at my request, and I approved each step.
- Pre-flight, all verified:
  - None of the bench's questions had a `searchCache` row. A read-only script checked their keys.
  - The agent had started after the newest source save.
  - 12 concurrent reads warmed its database connections.
- Not covered here:
  - The 2026-09-29 session (`a0661ee`, `e3287b8`, `239362d`, `d7f35ee`) has no journal entry.
    The progress file describes it.
  - `f9766e5` and `7b86b74` came from a later grounding session.

## What was done
- **The bench ran once, on `e3287b8`** (verified): exit 1, about $3 of model spend. Archived in
  `reports/baselines/2026-09-29_full_e3287b8/`, with a README.

  | Metric | First run | This run | Target |
  |---|---|---|---|
  | TTFT p95 (p50) | 10.2 s (6.1) | 4.4 s (2.7) | 2.5 s ✗ |
  | Quick answer p95 | 15.6 s | 9.8 s | 12 s ✓ |
  | Cache hits | 12.5 % | 50 % | 50 % ✓ |
  | Quick budget | 3/75 over | 0/73 | 0 ✓ |
  | Grounding | 0.881 | 0.801 | 0.95 ✗ |
  | Error rate | 0 | 0.025 | 0.01 ✗ |
  | Memory save/recall/delete | pass | fail | ✗ |

- **Why each new miss happened**, found in the run logs (verified):
  - **Memory:** the "Remember this preference…" ask (`req_c8e71542-393`) ran recall and the
    pre-search, then wrote 28 tokens, with no `save_memory` call. Since `97ee5ef`, a standalone
    question skips the research turn, and that turn was the only one that offered `save_memory`.
  - **Errors:** both were single OpenAI embeddings 500s inside `recall_memory`, 65 s apart, and
    each ended its run.
  - **The 1103 ms upload 202** was the p95 of 5 samples, which is simply the largest: the 60-page
    PDF's one accept. The four corpus files took 438–565 ms, the same as the first run.
- **The memory fix, `2dae72a`** (verified).
  - `rememberIfStated()` in `loop.ts` is a Haiku turn whose only tool is `save_memory`. It runs for
    every standalone quick question.
  - For those questions the research turn no longer offers `save_memory`.
  - Haiku alone, 54 calls with each case twice: 0/40 saves on the 20 bench questions, 12/12 on 6
    preferences, 0/2 on a preference that was already saved. About $0.0008 a call.
  - End to end, 8 new questions at concurrency 4 (one run): the wait before `sources` was 0–219 ms
    on the warm batch of 4, and 0.6–1.5 s on the batch right after a reload.
- **The embedding retry, `bc1018f`** (verified).
  - `embed()` retries once, after 300 ms, when `ProviderError.retryable` is true.
  - A `fetch` that gets no reply at all now throws a `ProviderError`.
  - A stand-in `fetch` passed 6 of 6 cases, and one live call worked.
- **DESIGN.md (`dd96789`) and progress (`891542c`)** record both fixes. I also wrote a handoff for
  the grounding diagnosis.

## Decisions
- **Memory: a separate turn.** Two other options were rejected:
  - Offering `save_memory` inside the streamed Sonnet answer would need a tool loop in the part the
    user watches, at Sonnet's price.
  - Not skipping research for statements about the user needs a word-pattern gate. It would miss
    "Use metric units from now on", with no error to show it.
- **The memory turn ends before `sources`.** The plan was to run it beside the answer, but the
  contract is `trace* → sources → token* → done`, so a trace can't follow a token. It isn't fully
  off the critical path.
- **It waits for recall first.** `saveMemory` has no duplicate check; the tool relies on the model
  seeing what is already known.
- **Only one turn may save.** Follow-ups keep `save_memory` in their research turn, because that
  turn sees the thread.
- **Recall stays fatal; I retry instead.** SPEC §5 says a provider exception ends the run with a
  502, and rule 3 forbids a plausible answer built on one. An answer that quietly drops the
  user's preferences is one.
- **The retry lives only in `embed()`.** The worker calls `embedMany()` and already retries whole
  jobs. For the 300 ms delay: *rationale not discussed*.

## Dead ends
- Claude first proposed making recall non-fatal, before reading the spec, and withdrew the
  proposal after reading it.
- `bench.json`'s `answers` is a count, not a list, and `notes` was empty. The errors were in the
  `terminated` field of the run logs.
- `@lumina/contract` and `@anthropic-ai/sdk` don't resolve from `/tmp`, again.
- Two commands with `cd ..` ran from different directories. The run logs were selected by
  modification time instead.

## Learnings
- **A turn you skip takes all its duties with it.** Before removing a model turn, list everything
  it owned, not only what it cost.
- Only `ProviderError` ends a run, so a failure thrown as the wrong type quietly became "no
  memories".
- The p95 of five samples is just the largest sample.
- The bench's `memoryRecalled` only checks that recall ran. Right after a save, recall found 0
  memories. The cause is unverified.

## Open questions and next steps
- Grounding: handed off to a later session.
- TTFT p95 is 4.4 s, and I chose to keep Sonnet and Tavily `fast`.
- The corpus-file 202 at 438–565 ms has never been investigated.
- The memory turn's warm cost rests on n = 4, and the error rate is only re-measured by the next
  bench.

**ADR candidates:**
- One turn per question decides what to remember, and a standalone question gets a turn whose
  only tool is `save_memory`.
- Provider failures stay fatal, and an ask-time embedding gets exactly one retry.
