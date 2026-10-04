# DESIGN.md — LUMINA

## Components

LUMINA has three things I build or deploy, one database, three outside providers, and one
evidence file.

1. **React UI**, on Vercel, public. The screen the user sees. It is provided and I do not
   change it. It talks only to the gateway.
2. **Gateway**, on Fly.io or Vercel, public. The front door. Every request from the browser
   comes here first. It checks the user header, adds a request id, logs, validates, rate
   limits, and forwards the request to the agent service. It does the boring work so the
   agent service does not have to.
3. **Agent service**, on Fly.io, private network only. The AI backend. It runs the agent loop:
   ask the LLM, run the tool it picks, feed the result back, repeat, stream the answer. A quick
   question that stands on its own skips most of that loop: one search brings back the pages as
   well as the links, and the answer is written straight from them. The full loop runs for
   follow-ups, for deep search, and when that one search comes back thin. A quick message that is
   only small talk, such as "Hi!" or "thanks", searches nothing and gets a short reply. Quick and deep search,
   memory, and document search all live here. Nobody outside can reach it, only the gateway.
4. **Jobs worker**, its own process, same code as the agent service. It picks up upload jobs
   from Mongo and does the slow work: parse the file, split it into chunks, embed them, write
   them, and check they can be found. It runs separately so a long PDF parse never blocks a
   streaming answer on the same thread.
5. **MongoDB Atlas**. The only durable state in the system, and it plays three roles at once:
   the system of record for threads, messages, memories, documents, and chunks; the vector
   index for chunks and memories; and the job queue plus the search cache. One cluster instead
   of four services, at the cost of tying everything to Atlas.
6. **Anthropic**, the LLM. It writes the answers, and on follow-ups and deep search it decides
   which tool to call next.
7. **Tavily**, web search and page extraction. It lets the agent search the web and read
   pages. For a quick question one call does both: a fast search that returns the pages' text
   along with the links. It can be swapped for SerpApi through one environment variable.
8. **OpenAI**, embeddings only. It turns documents, memories, and queries into vectors so they
   can be compared.
9. **Run logs**, one file per answer, in `runs/` locally or the `runs` collection in
   production. Each one records tokens, cost, wall clock, why the loop stopped, and the
   ordered list of tool calls. The grader reads these.

## Responsibilities

The React UI is the browser. The gateway is the only backend component the browser is allowed
to talk to, and the agent service is never reachable from it.

The gateway never sees an API key. Its only jobs are checking the user header, request ids,
logging, validation, the per-user rate limit, and passing requests and streams through to the
agent service. The rate limit counts only asks and uploads, the two routes that spend money.
Reads cost almost nothing, and the UI and the bench both poll them every second or so, so
counting them would lock out a user for watching an upload index.

The agent service is the only component that holds API keys and calls Anthropic, Tavily, and
OpenAI. It is also the only one that decides a request has gone over its limits: the tool-call
cap, the wall-clock cap, and the daily deep-search allowance. Those limits live here on purpose,
because this service is private, so nobody can skip them by calling it directly.

The agent service is the only component that writes long-term memory, and only through an
explicit `save_memory` tool call. Nothing is remembered that `GET /memory` does not show.
Exactly one model turn per question may make that call. For a follow-up it is the research
turn, which sees the thread. For a question that stands on its own it is a small turn whose
only tool is `save_memory`, because that question usually skips the research turn altogether
(trade-off 6). Before that turn existed, "remember that I prefer…" got a reply saying it would
be remembered, and nothing was saved.

The jobs worker is the only component that can mark a document as `indexed`, and only after
it has searched for one of the chunks it just wrote and found it.

MongoDB stores all of this but decides none of it.

## Communication

Five pairs of components talk to each other. Four use a network; one uses the database as a
mailbox.

**Browser to gateway.** Plain HTTP with a JSON body, on every route. Only `/threads/{id}/ask`
adds SSE on top, so the user sees the answer as it is written instead of waiting for the whole
thing. Every request carries `X-User-Id`. If the gateway is down, the fetch fails and the UI
shows the error.

**Gateway to agent service.** The same HTTP, and the same SSE for `/ask`, forwarded as-is over
Fly's private network so no API key ever sits on a public host. The gateway passes the body,
`X-User-Id`, and `X-Request-Id` through unchanged, which is why one request id appears in both
services' logs. Requests that fail at the gateway never reach the agent: missing user header is
`401`, bad body is `400`, over the rate limit is `429`. Refusals the agent makes before a stream
opens, an unknown thread or the deep-search cap, come back as plain JSON and the gateway passes
them on unchanged. On `/ask` the gateway relays each SSE
event to the browser the moment it arrives, with no buffering. If the agent is unreachable
before the stream starts, the gateway returns `502` and `/health` says `degraded`. If the agent
dies mid-stream, the gateway sends an `error` SSE event to the browser and closes the
connection, because the `200` and the headers are already sent and a status code can no longer
carry the failure. It relays whole SSE frames only, so its own `error` event never lands inside
a half-sent one, and a stream that closes without a `done` or an `error` event is reported as an
error too: a stream that just stops is not a finished answer.

**Agent service and worker to MongoDB.** Both use the Mongo driver with one pooled connection
per process. If Mongo is unreachable, an in-flight ask fails loud with `502`, the agent's
`/health` reports `db: down`, and the worker logs each failed poll and keeps polling, waiting a
little longer each time up to 30 seconds, until Mongo is back. The first version did not keep
that promise: one failed poll ended the worker process, and I only found out because an upload
sat at `pending` with nothing saying why. The agent broke it once too. Every route goes through a
wrapper that turns a failed database call into a `502`, and `/stats` had been left out of it, so
when Atlas stopped resolving overnight, the UI's next `/stats` poll ended the whole agent process
and nothing restarted it. Now `/stats` goes through the wrapper like every other route.

**HTTP process to worker.** They never talk directly. The upload handler writes a `pending`
document row and a `pending` job row and returns `202` at once. The worker polls the `jobs`
collection every second, claims a job atomically, and writes its progress into the `documents`
row, which the browser polls through `GET /spaces/{id}/documents`. The queue is what lets the
upload handler answer in under 300 ms, and it is what survives a crash: if no worker is running, the
document stays `pending` and nothing is lost; if a worker dies mid-job, a sweeper returns the
stale `running` row to `pending`. Nothing being lost is not the same as someone knowing, so the
worker also writes a heartbeat to Mongo every 5 seconds, and the agent's `/health` reads the
newest one. After 15 seconds without a beat it reports `worker: down` and `status: degraded`,
still with a `200`: asks keep working, so this is a partial outage, not a dead agent.

**Agent service and worker to providers.** The agent calls Anthropic, Tavily, and OpenAI over
HTTPS. The worker calls only OpenAI, for embeddings. When a provider throws inside the agent,
the loop stops, the run log says `terminated: "error"`, and the caller gets `502`, or an
`error` SSE event if the stream has already started. The one exception is a short blip on an
embedding the agent needs while answering: if OpenAI is rate limiting, overloaded, or does not
reply, the agent waits 300 ms and tries once more, and a second failure ends the run as above.
The second full bench's only two errors were single OpenAI 500s. I also considered answering
without the user's memories when recall fails, and said no: an answer that quietly drops "keep
it under 100 words" is a plausible answer built on an exception, which is what the `502` rule
is there to prevent. When a provider throws inside the worker,
there is no caller to tell, so it writes `failed` and the error string onto the job and the
document, where the next poll finds it.

## State

Everything durable lives in one MongoDB Atlas cluster, in twelve collections plus a GridFS bucket
for the raw uploads. Every user's document carries the `userId` it belongs to, and the agent
service and the worker are the only writers. The gateway stores nothing durable.

The collections fall into five buckets, sorted by what happens if you delete them.

| Bucket | Collections | If deleted |
|---|---|---|
| Authoritative | `threads`, `messages`, `memories`, `spaces`, `documents`, `jobs`, GridFS uploads | Gone for good. `jobs` looks disposable but is not: while a row is `pending`, it is the only record that work is still owed. |
| Cache | `searchCache`, `pageChecks` | Nothing breaks. The next search misses, calls Tavily, and refills the row; a browser-only page is read once more, then checked and skipped again. Mongo already expires rows on its own through a TTL index, so the system is built to run with holes in it. |
| Derived | `chunks` | Document search goes empty until every document is reset to `pending` and re-indexed. Rebuildable from GridFS, but not on its own, and the user notices in the meantime. |
| Evidence | `requests`, `runs` | The product works the same. `/stats` drops to zero and the grader has nothing to read. |
| Liveness | `workers` | Nothing is lost. `/health` calls the worker down until its next heartbeat, at most 5 seconds later. |

Who owns what: the agent service's HTTP process owns threads, messages, memories, spaces, the
search cache, the page checks, and the request and run records. The upload handler creates a document row and its
job row. From then on the worker owns that document's status and everything in `chunks`, and each
worker process owns its own heartbeat row in `workers`.

An answer reads only the part of its thread it uses. Before the stream opens, an ask reads the
last six messages, role and text only. At first it read the whole thread with every answer's
sources, and that download grew with every question: on the bench's 80-message thread it took
1.6 to 2.0 seconds, all of it before the user saw anything. The last six come back in about 0.1
seconds however long the thread is. The UI still reads the whole thread, because it shows it all.

Three pieces of state live outside Mongo, in memory, and all three are lost on a restart. The LRU
in front of `searchCache` is a pure cache and refills from the collection. On a miss the LRU gets
the new result first, and the Mongo row is written after the answer has moved on, because that
write took 110 to 215 ms the first word used to wait for. So for a moment, or for good if the write
fails, this process knows a result the collection does not. A failed write is logged as an error
and costs a later miss, never a wrong answer. The agent's in-flight
deep-search reservations and the gateway's per-user rate-limit buckets are counters: a restart
forgets them, which costs at most a few extra requests, and a second machine would need them in
a shared store before they meant anything across machines.

The consistency story for uploads is the one place where "written" and "visible" are not the
same thing. Atlas Search indexes are eventually consistent: when the worker inserts a chunk,
the insert succeeds at once, but a separate background process adds it to the vector index a
moment later. In that window the chunk is in the database and invisible to search. So a chunk
passes through three states: written to the collection, picked up by the index, and confirmed
findable. The worker marks a document `indexed` only after the third, by running a real vector
query for one of the chunks it just wrote and getting it back. Until then the document row says
`embedding`, and the UI tells the truth about it by not saying `indexed` yet.

## Trade-offs

Six decisions where a reasonable engineer would have picked differently. In each case I chose
fewer moving parts and paid for it somewhere else.

1. **Atlas Vector Search instead of a dedicated vector store** like Pinecone or Qdrant. The
   embedding, the chunk text, and the page number live in one Mongo document, so a citation is
   one read and there is no second store whose ids must agree with the first. What I gave up:
   the free M0 tier allows exactly three search indexes and LUMINA uses all three, so there is
   no room to add another without paying, and every part of the system is tied to Atlas.

2. **MongoDB as the job queue instead of Redis with BullMQ.** The `jobs` collection plus an
   atomic `findOneAndUpdate` is the whole queue, so there is one less service to deploy, secure,
   and pay for. What I gave up: the worker polls every second instead of being woken at once,
   and the claim, retry, sweeper, and failure handling are my code rather than a library's.
   Kafka was never the alternative here; a handful of uploads a day is a job queue, not a stream.

3. **A two-tier search cache, in-process LRU over a Mongo TTL collection, instead of Redis.**
   Hits on the LRU cost nothing, and the Mongo tier survives restarts and expires itself. What I
   gave up: the LRU is per process, so if I ever run two agent machines they share only the
   slower Mongo tier. And Mongo sweeps expired rows about once a minute, so the code has to check
   `expiresAt` itself or it can serve a result a few seconds past its TTL. The key is the text that
   was searched, so a repeat only hits if it searches the same words. That is why the question is
   always searched first exactly as the user typed it, even deep in a thread. The first version
   skipped that whenever the thread had history and left the wording to the model, and the model
   rarely worded a repeat the same way twice: the first full bench measured 12.5 % hits on a
   workload that was half repeats.

4. **The worker as a separate process instead of a `worker_threads` thread.** A crash while
   parsing a bad PDF cannot take the HTTP server down with it, and the two can be restarted and
   scaled on their own. What I gave up: a second deployable to run, watch, and keep in sync with
   the first, and a slightly longer path from "job written" to "job started."

5. **Two providers, Anthropic for the LLM and OpenAI for embeddings.** Each does what it is best
   at, and the embedding model is the one the assignment names. What I gave up: two keys, two
   bills, and two services that can each be down. A memory or document query fails if OpenAI is
   unreachable even when Claude is fine. One retry covers a blip, not an outage.

6. **Quick search reads the pages the search engine ranks highest, instead of letting the model
   choose which to read.** A quick question that stands on its own gets one Tavily call in its
   fast mode, which returns the text of the top pages along with the links, and the top four
   pages with real text become the sources. Before, a model turn read the results and picked the
   pages to fetch, and that turn plus the fetches were about 2.7 of the 6.6 seconds a user waited
   for the first word. On the same six questions the median wait went from 6.6 to 2.5 seconds.
   What I gave up: the model no longer judges which results are worth reading, the fast mode may
   rank less well than the default one, and only a question that does not look like a follow-up
   gets this path. A few word patterns make that call: "and…", "the second one", "does it…", a
   question of three words or fewer. A follow-up that slips past them is searched without the
   thread, so its sources can miss the point, and the most the answer can do is say so. Under the
   bench's load the 95th percentile was still 5.7 seconds against a target of 2.5, so this was
   the biggest cut, not the last one. After the next cut, reading only the last six turns of the
   thread, a run shaped like the bench put new questions at 3.2 seconds at the 95th percentile,
   and the second full bench measured 4.4 seconds (median 2.7). What is left is the search itself
   and the time to the answer model's first word. Skipping the research turn also skipped the
   only place memory was saved, which the second bench caught. Remembering is now a turn of its
   own that runs beside the search (see Responsibilities). It costs about $0.001 a question, and
   when looking up memory and then deciding what to save take longer than the search, the
   sources wait for them, because the stream has no place for a step after the first word: 0 to 0.2 seconds
   in one warm probe of four questions, up to 1.5 seconds just after a restart.
   The same cut cost me grounding. The search engine happily ranks pages a plain reader cannot
   quote from: a video, or a forum or site whose text only appears after a browser runs it. Of the
   41 citations the second bench could not find on their pages, 11 were pages like that; the first
   bench, where the model picked the pages, had none. So quick search never reads a video page, and
   every other page it reads is checked after the answer with a plain request. A page with under
   100 words of text in its HTML is remembered as browser-only for a week, and so is a whole site
   with two such pages and no readable one, and the next answer skips them. What I gave up: a page
   is still read unchecked the first time it shows up, and a site's bad pages decide for its good
   ones until one good page gets checked. Checking before the answer would have caught every one,
   but on 29 questions it added 2.2 seconds at the median before the sources, and the pages it
   catches were among the slowest to fetch.
   The third bench found all 202 checkable citations on their pages, and it also found what the
   skipping cost. Quick search goes straight to the answer only when it has read at least two
   pages; with fewer, the model gets a turn to search again and fetch. For one question, four of
   the five results were threads on a site the check had marked, so one page was read. The
   model's turn then fetched one of those same threads, which failed, and searched again in other
   words: seven tool calls, about 15 seconds before the first word, more than the $0.05 a quick
   answer may cost, and the repeat missed the cache because nobody had searched those words
   before. So one page is now enough when the other results were skipped as unreadable. What I
   gave up: such a question is answered from a single page, where a turn of searching might have
   found a second good one. I have checked it on a staged search but not yet on a bench, because
   the same question now returns four readable pages.
   The fourth bench, the last I ran, did not reach this rule either: the same question took the
   fast path both times, and every bench question read three or four pages, so the rule is still
   untested on a bench. It found a different gap instead. About half of the citations it could
   not find on their pages were language versions of a page (Danish, French, Chinese) that the
   search engine had handed me in English, while a plain fetch of the same address returns the
   translation. Grounding came out at 0.949 against 0.95, and I stopped there.
   Searching first also searched messages that ask nothing. On the deployed app "Hi!" read four
   pages about the word "hi", and the answer explained the greeting from them. So another fixed
   list of word patterns now catches a quick message made only of greetings, thanks, goodbyes, or
   "who are you" and "what can you do". It searches nothing, still looks up memory (a reply may use
   a name), sends an empty source list, and is answered in a sentence or two for about $0.002.
   What I gave up: small talk that is not on the list is still searched as before, and the list
   only matches whole messages, so "hi, what is RAG?" is searched like any question. I chose a
   list over a model turn because the turn would add time before the first word of every
   question, and that is the number I am already missing.

The one I am least sure about is number 4. For one cohort's load the crash isolation may never
matter, and a `worker_threads` thread inside the agent process would be one fewer thing to deploy
and one fewer thing that can silently not be running. I chose the separate process because the
failure it prevents, a stalled upload with no error, is the kind that nobody notices until a
user complains. If it turns out to be more operational cost than it is worth, it is a small
change to move the loop into a thread.

The worry came true in development before the first deploy. The worker process died on one
failed Mongo poll, the agent kept answering questions, and an upload sat at `pending` with
nothing anywhere saying why. The isolation did its job, since the crash never reached an answer,
but it also made the crash silent. A separate process needs its own way to be seen, so the fix
was two changes, not one: the poll loop now survives a failed poll, and the heartbeat puts a
dead worker on `/health` within 15 seconds. What the heartbeat still cannot see is a worker that
is alive but stuck: a call that never returns keeps the timer beating, and the sweeper cannot
rescue the job because it runs inside that same stuck loop. That is the gap I would close next,
with a timeout on every provider call the worker makes.
