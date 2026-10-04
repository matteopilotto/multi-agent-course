# 2026-10-04 — LUMINA: the fourth and last bench, two fixes that never fired, and pages in the wrong language

## Goal
Run one full bench on `e2f2b39` to measure options A (`2b51f1a`) and B (`f1b70ae`) against the
third run. Change no code before or during it, and diagnose any miss afterwards.

## Context
- I started from a handoff note written that morning. I used answers-now mode: Claude proposed,
  I approved, Claude applied.
- A lets quick search answer from one read page when the others were skipped as browser-only.
  B marks those pages in `web_search`'s list and refuses a `fetch_page` of them.
- Spend: one bench, about $3–4. Everything after it was free.

## What was done
- **Pre-flight** (verified): `searchCache` had 0 rows, so 0 of the 58 bench keys were warm. The
  agent had started with the newest save and answered nothing, and it loaded 152 page-check
  verdicts (the third run started with 9). `/health` showed `db` and `worker` ok, and 24 warm-up
  calls returned 200.
- **The bench** (verified, one run, exit 1), archived in the git-ignored
  `reports/baselines/2026-10-04_full_e2f2b39/`:
  - **Now pass:** cache hit 50 %, quickBudget 0/75, answer p95 10 588 ms, deep plan p95 3398 ms.
  - **Miss:** TTFT p95 3257 ms (was 11 353), 202 accept p95 731 ms, grounding 0.949 (was 1.0).
- **Neither fix fired** (verified):
  - The Tavily extract question took the fast path both times, with one search.
  - Replaying all 24 cached `fast-pages` rows through `skipAsPage` showed 3–4 pages read for
    every question, so A's one-page case never came up. Tavily now returns 4 readable pages for
    that question.
  - B logged 0 refusals. All 10 refusals in the log were deep budget refusals.
- **Grounding** was rebuilt free from Mongo's `messages` with the bench's own `snippetIsGrounded`
  and `citationNumbers`. It gave 12 failures against the bench's 11, not the identical set.
  - **6 were locale pages:** crazyrouter.com `/da/` and `/fr/`, lobehub.com `/zh/`. The snippet is
    English, but a plain fetch gets Danish or Chinese (verified with `curl`). Each failed twice,
    because the repeat ask reused the cached pages.
  - **2–3 were deep snippets equal to a page's `<meta>` description or keywords**, which the
    bench's `stripHtml` drops (verified on 2 pages). That the text comes from Tavily's Extract
    markdown is proposed, not confirmed.
  - **3 were other.**
- **DESIGN.md** `4e22019` (I read it first): trade-off 6 now ends with this bench.
- **Progress** `4497436`.

## Decisions
- **No more benches:** I need to wrap up the project. Grounding, TTFT, the 202 accept time and
  C stay known limitations.
- **No paid Extract call to confirm the meta-tag source:** Claude proposed it at about $0.01, and
  it was dropped with the wrap-up.
- **Rebuilding grounding from Mongo rather than the gateway:** *rationale not discussed*.

## Dead ends
- The warm-cache script failed twice. `COLLECTIONS` isn't exported from `db.ts`, and
  `@lumina/contract` doesn't resolve from a script in `/tmp`. The collection name as a string
  worked.
- The grounding script first matched 0 messages, because `createdAt` is a `Date`, not a string.
- The `runs/*.json` files have no `query` field. The `runs` collection has it.
- Claude first reported quickBudget as a miss and corrected it from the caps block.

## Learnings
- **Check why a metric passed before crediting a fix.** Cache hits and quickBudget passed because
  Tavily's results changed, not because of A.
- **A cache doubles a bad citation:** the repeat reuses the same pages and the same failure.
- **A URL's language path is not the language the provider returns.**

## Open questions and next steps
- A and B are untested on a bench.
- Not deployed. Submission (SPEC §19) still needs Vercel, `/fde-lumina-eval` against the
  deployed gateway (a paid rerun of `bench.mjs`), the recording and the "How I ran it" notes.

**ADR candidates:**
- None from this session: it changed no code.
