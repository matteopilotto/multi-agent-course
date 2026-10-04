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

---

# 2026-10-04 (later) — LUMINA: Enter to send, and a revert because `web/` is not mine to edit

## Goal
In the question box, Enter should send the question and Shift + Enter should add a new line.
Then deploy the change.

## Context
- The provided UI's `Composer` (`web/src/components/Composer.tsx`) sent only on Cmd/Ctrl +
  Enter. Plain Enter added a new line.
- This entry covers only this session. The seven commits between `fd83d3a` and this session
  (`731b01d` deploy through `8cc720e` freshness fix) came from other sessions that were not
  journaled. Their reasons are in the commit messages and `progress/learner-progress.md`, not
  here.

## What was done
- **`1bba69e`**: in the textarea's `onKeyDown`, Enter without Shift called `preventDefault()`
  and the same `submit()` as the Ask button. That kept the busy and empty-input checks, and
  Cmd/Ctrl + Enter still sent. An Enter during IME composition (`e.nativeEvent.isComposing`)
  was left alone, so picking a Japanese or Chinese candidate would not send. The placeholder
  was updated. **Verified:** web typecheck and lint passed. **Not verified:** never tried in a
  browser.
- **The deploy did not happen.** I asked for Fly. Claude checked first and found two problems:
  - The `Dockerfile` deletes `web/`, so Fly runs only the agent and gateway and a Fly deploy
    would not ship the change. The UI is on Vercel.
  - `AGENTS.md:21-23` lists `web/` as DO NOT EDIT. `SPEC.md:333` makes "provided `web/` …
    edited" an auto-flagged red line.
- **`8fd6d36`** reverts `1bba69e`. **Verified:** `git diff 1bba69e~1 HEAD` is empty, so `web/`
  matches the provided version. Nothing deployed, nothing pushed.

## Decisions
- **Revert (option A)** over deploying to Vercel and accepting the flag (B), or keeping the
  commit undeployed (C). Claude recommended A because the red line is graded. I chose A.
- **A revert commit, not a history rewrite:** *rationale not discussed*. The grader checks files,
  and `web/` files now match the provided version.

## Dead ends
- The change itself. Claude edited `web/` without checking `AGENTS.md`'s do-not-edit list,
  although `progress/learner-progress.md` already called `web/` a red line in the Vercel notes.
  The problem only surfaced at deploy time.

## Learnings
- **Check the do-not-edit list before touching a provided folder**, even for a one-line UX fix.
  A fix that looks harmless can still hit a graded red line.
- **Where a change deploys follows the folder:** `web/` goes to Vercel (a static build against
  the gateway), and the agent and gateway go to Fly. "Deploy to Fly" ships no UI change.

## Open questions and next steps
- Enter-to-send stays out of scope while `web/` is provided. SPEC lists a learner-built UI
  replacing `web/` as a stretch option, and that would be the place for it.
- Still open from the progress file: the quick answer prompt does not forbid markdown, so a
  list answer shows `**` in the plain-text UI.
- Submission, per the progress file: the app is now deployed (`731b01d`). Still open are
  `/fde-lumina-eval` against the deployed gateway (a paid bench rerun), the recording, the
  "How I ran it" notes, and provider spend limits.

**ADR candidates:**
- None: the only code change was reverted.

---

# 2026-10-04 (evening) — LUMINA: "chapter 14 was not there", a title that searched the cover, and a research turn only where it pays

## Goal
On the deployed app, "what are the main takeaways of chapter 14 of the book 'software design for
python programmers'?" answered that the search did not surface chapter 14, and the whole book
was indexed. Find out why, fix it, and deploy.

## Context
- The Space held `software-design-python.pdf` (458 pages, 780 chunks). Midway I uploaded
  `fluent-python.pdf` (1011 pages, 1755 chunks) to test the fix with two books.
- Claude ran the `diagnosing-bugs` skill and built a read-only loop against Atlas before
  forming any theory.

## What was done
- **Diagnosis** (verified): the production run was a deep search. All three sub-questions began
  with the book title, and all cited pages were front matter (pp. 18–35) or the back cover
  (p. 458). Chapter 14 is pp. 352–384. Replayed through `hybridSearchChunks`, those queries
  missed 3/3; without the title, "chapter 14 main topics" hit. The title's words match the
  pages *about* the book. `docsFull()` then skipped the research turn, because hybrid search
  always returns 5 passages.
- **`1d7f8cc`**:
  - `search_documents` takes an optional `document` (enum of the Space's file names). The filter
    runs after `$vectorSearch`/`$search`, which read 400 chunks deep (`RAG_DOC_FILTER_DEPTH`).
  - The planner can limit a sub-question to one document and keeps titles out of its questions.
  - `namesDocumentPart` (every word of a file name, or "chapter 14"/"page 12"/"appendix B")
    gives that question a research turn.
  - A document search gets one more turn to be read, and only the latest turn's lists reach the
    answer.
  - DESIGN.md trade-off 7.
- **Local checks** (verified, one run each):
  - Quick: 5/5 sources from chapter 14, TTFT 6.7–8.9 s.
  - Deep: 8/16 sources from chapter 14, TTFT 11.3 s, $0.063.
  - Fluent Python in `auto` mode: limited to that book.
  - 30 bench gold questions: recall@5 30/30, TTFT p50 2.26 s, p95 2.66 s, no re-searches.
- **Deployed** the agent app (`fly deploy -c fly.agent.toml --remote-only --ha=false`), both
  machines healthy. One live quick run answered from chapter 14 with 3 of 5 sources from it,
  TTFT 3.9 s (verified, one run).

## Decisions
- **Filter by document, not strip the title** (Claude's first option 1). I asked what happens
  with several books. Claude said a bare "chapter 14" would match every book's chapter 14, and
  the two-book loop confirmed it: unfiltered, it returned only Fluent Python pages.
- **Filter after the search:** `scripts/indexes.json` is DO NOT EDIT, and it has no `docId`
  filter field. Depths of 100, 400 and 2000 gave the same results on these books.
- **Narrow the research turn to a word-list trigger.** Giving every document question the turn
  made TTFT p95 5.8–6.1 s, because the model re-searched 20–24 of 30 gold questions whose
  first search was already right. Claude recommended the trigger, and I approved.
- **Another turn after a model search, and the latest lists only:** the first re-search found
  the contents page, and the next used the chapter title it read there. Fused with the earlier
  lists, the contents pages took half of the top five.
- **File name as the only title:** Claude proposed a PDF metadata title, but it was not built;
  *rationale not discussed*.

## Dead ends
- A prompt line telling the model passages are cut to 300 characters: re-searches went from
  20/30 to 24/30.
- `numCandidates` above 10000 makes Atlas throw; it is clamped now.
- npx fetched Prettier 3.9, which reflowed unrelated lines; Claude reverted them.
- Tooling slips: the bench `pool()` returns `{ok, value}` (scored again from Mongo),
  `createdAt` is a `Date` (again), and zsh does not split `$VAR` (the run-log delete was redone).

## Learnings
- **A full top-k is not a relevant top-k.** "5 passages" told the harness nothing.
- **Title words find the pages about a document, not the part asked about.**
- **A turn offered is a turn used:** Haiku re-searched when given the chance, and prompting did
  not stop it, so the gate went in the harness.

## Open questions and next steps
- The live run hit `MAX_DOC_SEARCHES=3` with two parallel searches, before the title search.
  Raising it to 4 is proposed, not done.
- In deep search, sub-questions still land on contents pages.
- `progress/learner-progress.md` not yet updated.
- Test threads: 8 on `u_4tpnxice`, 91 on `bench`.

**ADR candidates:**
- Limiting a search to one document by filtering after the search, because the provided indexes
  filter only by Space and user.
- A word-list trigger, not the model, decides when a document question gets a research turn.

# 2026-10-04 (night) — LUMINA: the bench against the deployed app, a 202 miss that is the Atlantic, and the report

## Goal
Run the eval against the deployed gateway (https://matteopilotto-lumina-gw.fly.dev) and build
`reports/report.json` for the `/evals` page.

## Context
- The deployed agent (Fly, `iad`) and my local dev processes use the same Atlas database,
  `lumina`. That shared database caused most of this session's preparation.
- No code changed. Everything happened in Mongo, on Fly, and in git-ignored files.

## What was done
- **Pre-flight** (verified):
  - `searchCache` held 91 rows from the morning bench, and 28 of them were bench questions.
  - My local agent, gateway and worker were running against the shared database.
  - `runs/` held 543 local run logs.
- **Clean-up:**
  - Stopped the local processes at **13:32:00Z**, which became the cutoff for "deployed only".
    `/health` then showed the Fly worker's own heartbeat.
  - Moved `runs/` to `reports/baselines/2026-10-04_local_runs_before_deployed_eval/`.
  - Deleted all 91 `searchCache` rows and restarted the agent's app machine (`83ddde9f76d508`),
    which also empties the in-memory cache.
- **Export:** wrote `/tmp/lumina-export-since.mjs`. It has the same output shape as
  `scripts/export-runs.mjs` but keeps only runs created after the cutoff.
- **Full bench** (`node eval/eval.mjs --deploy-url …`, one run, verified):
  - Gates 0–3 passed. Gate 4 failed on one target: **202 accept p95 329 ms** against 300.
  - Everything else passed: TTFT p95 1883 ms, answer p95 6031 ms, grounding 0.969 (186/192),
    recall@5 30/30, cache hit rate 50 %, deep plan p95 3451 ms, deep/quick source ratio 2.5×,
    error rate 0.
  - Exported 108 deployed runs. All ended `done`, and `check.mjs` passed.
- **202 measurement** (free, verified, 6 runs each, from my laptop):
  - Round trip 140 ms. A 7 KB upload 162 ms. The bench's 60-page PDF (24.6 KB) median 236 ms,
    range 181–251.
  - In the gateway's log, my PDF uploads took 50–119 ms. The bench's one PDF upload took 189 ms.
  - The bench took only 5 upload samples, so the p95 is the slowest one.
- **P1 (human gate):**
  - Successful: `req_5e828add-f27`, deep, 22 steps. Step 6 was a 404 on `fetch_page`. Its
    sub-question kept 2 pages and did not search again.
  - Failing: `req_5feb306a-980`, this morning's deployed Sonnet 5.5 400. Both steps say ok and
    no reason is recorded.
  - Claude drafted the notes from what I worked out, and I approved them
    (`reports/p1-notes.md`).
- **Deep-search quality:** asked the pgvector question at quick ($0.033, 4 sources) and at deep
  ($0.158, 15 sources, 4 sub-questions). My judgment is in `reports/deep-quality-comparison.md`.
- **Report:** `build-report.mjs` gave **82/85 automated** (Performance & SLA 7/10) and left
  15 points for a grader.
- **Not done:** the gateway redeploy that makes the report live (blocked, see below).

## Decisions
- **Delete every cache row, not just the 28 exact questions:** about 50 rows were the bench's
  reworded sub-questions. Earlier benches also started from 0 rows.
- **Filter the export by time:** the provided script takes the newest 500 runs from the shared
  collection, which would have mixed local runs back in.
- **Accept the 202 miss as a known limitation instead of a second $3–4 bench:** the agent only
  does a few same-region Atlas calls before the 202. A re-run could only produce a luckier
  sample. The skill says not to build the report with a failed gate; I chose to anyway.
- **Keep the real failing run** instead of breaking the Tavily key on production.
- **One thread per depth** for the deep-quality question, so deep could not read the quick
  answer as history. The skill's example uses one thread.

## Dead ends
- Blocked by the permission check:
  - the first `deleteMany`, which ran once I said "empty the cache"
  - an upload timing run inside Fly over `fly ssh`
  - `fly deploy` of the gateway
- `fly logs --no-tail` shows only the last 100 lines, so this morning's 400 message was gone.

## Learnings
- **One database, three contaminations:** a warm cache, a local worker that could take the
  deployed jobs and stand in for the deployed worker's heartbeat, and local runs in the export.
- **The run log says *that*, not *why* or *where*.** Matching a failed step to its sub-question
  took `runs`, `messages` and a comment in `loop.ts`. A failed answer call leaves no reason at
  all.
- **A p95 over five samples is the maximum.**

## Open questions and next steps
- Run `fly deploy -c fly.gateway.toml --remote-only --ha=false` myself, then check `/evals`.
- Record the 60–90 s video, rebuild with `--video`, and redeploy the gateway.
- "How I ran it" notes, provider spend limits, and the progress file.
- Throwaway users `uploadcheck-mutxy22q` (12 uploads) and `deepquality-mutzplmx`, and the
  scripts in `/tmp`.

**ADR candidates:**
- A bench against the deployed app needs the local processes stopped and a time cutoff,
  because local and deployed share one Atlas database.
- The 202 accept p95 miss is accepted as a known limitation, measured from Europe.
- Save the error message and the failing step in the run log when a run ends in `error`
  (proposed).
