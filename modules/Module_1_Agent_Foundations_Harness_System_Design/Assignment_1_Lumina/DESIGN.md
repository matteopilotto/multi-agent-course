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
   ask the LLM, run the tool it picks, feed the result back, repeat, stream the answer. Quick
   and deep search, memory, and document search all live here. Nobody outside can reach it,
   only the gateway.
4. **Jobs worker**, its own process, same code as the agent service. It picks up upload jobs
   from Mongo and does the slow work: parse the file, split it into chunks, embed them, write
   them, and check they can be found. It runs separately so a long PDF parse never blocks a
   streaming answer on the same thread.
5. **MongoDB Atlas**. The only durable state in the system, and it plays three roles at once:
   the system of record for threads, messages, memories, documents, and chunks; the vector
   index for chunks and memories; and the job queue plus the search cache. One cluster instead
   of four services, at the cost of tying everything to Atlas.
6. **Anthropic**, the LLM. It decides which tool to call next and writes the answers.
7. **Tavily**, web search and page extraction. It lets the agent search the web and read
   pages. It can be swapped for SerpApi through one environment variable.
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
agent service.

The agent service is the only component that holds API keys and calls Anthropic, Tavily, and
OpenAI. It is also the only one that decides a request has gone over its limits: the tool-call
cap, the wall-clock cap, and the daily deep-search allowance. Those limits live here on purpose,
because this service is private, so nobody can skip them by calling it directly.

The agent service is the only component that writes long-term memory, and only through an
explicit `save_memory` tool call. Nothing is remembered that `GET /memory` does not show.

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
`401`, bad body is `400`, over the rate limit is `429`. On `/ask` the gateway relays each SSE
event to the browser the moment it arrives, with no buffering. If the agent is unreachable
before the stream starts, the gateway returns `502` and `/health` says `degraded`. If the agent
dies mid-stream, the gateway sends an `error` SSE event to the browser and closes the
connection, because the `200` and the headers are already sent and a status code can no longer
carry the failure.

**Agent service and worker to MongoDB.** Both use the Mongo driver with one pooled connection
per process. If Mongo is unreachable, an in-flight ask fails loud with `502`, the agent's
`/health` reports `db: down`, and the worker keeps polling and finds nothing until Mongo is
back.

**HTTP process to worker.** They never talk directly. The upload handler writes a `pending`
document row and a `pending` job row and returns `202` at once. The worker polls the `jobs`
collection every second, claims a job atomically, and writes its progress into the `documents`
row, which the browser polls through `GET /spaces/{id}/documents`. The queue is what lets the
upload handler answer in under 300 ms, and it is what survives a crash: if no worker is running, the
document stays `pending` and nothing is lost; if a worker dies mid-job, a sweeper returns the
stale `running` row to `pending`.

**Agent service and worker to providers.** The agent calls Anthropic, Tavily, and OpenAI over
HTTPS. The worker calls only OpenAI, for embeddings. When a provider throws inside the agent,
the loop stops, the run log says `terminated: "error"`, and the caller gets `502`, or an
`error` SSE event if the stream has already started. When a provider throws inside the worker,
there is no caller to tell, so it writes `failed` and the error string onto the job and the
document, where the next poll finds it.

## State

Everything durable lives in one MongoDB Atlas cluster, in ten collections plus a GridFS bucket
for the raw uploads. Every document carries the `userId` it belongs to, and the agent service
and the worker are the only writers. The gateway stores nothing.

The collections fall into four buckets, sorted by what happens if you delete them.

| Bucket | Collections | If deleted |
|---|---|---|
| Authoritative | `threads`, `messages`, `memories`, `spaces`, `documents`, `jobs`, GridFS uploads | Gone for good. `jobs` looks disposable but is not: while a row is `pending`, it is the only record that work is still owed. |
| Cache | `searchCache` | Nothing breaks. The next search misses, calls Tavily, and refills the row. Mongo already expires rows on its own through a TTL index, so the system is built to run with holes in it. |
| Derived | `chunks` | Document search goes empty until every document is reset to `pending` and re-indexed. Rebuildable from GridFS, but not on its own, and the user notices in the meantime. |
| Evidence | `requests`, `runs` | The product works the same. `/stats` drops to zero and the grader has nothing to read. |

Who owns what: the agent service's HTTP process owns threads, messages, memories, spaces, the
search cache, and the request and run records. The upload handler creates a document row and its
job row. From then on the worker owns that document's status and everything in `chunks`. The
in-process LRU in front of `searchCache` is the one piece of state that lives outside Mongo, and
it is a pure cache: it is empty on every restart and refills from the collection.

The consistency story for uploads is the one place where "written" and "visible" are not the
same thing. Atlas Search indexes are eventually consistent: when the worker inserts a chunk,
the insert succeeds at once, but a separate background process adds it to the vector index a
moment later. In that window the chunk is in the database and invisible to search. So a chunk
passes through three states: written to the collection, picked up by the index, and confirmed
findable. The worker marks a document `indexed` only after the third, by running a real vector
query for one of the chunks it just wrote and getting it back. Until then the document row says
`embedding`, and the UI tells the truth about it by not saying `indexed` yet.

## Trade-offs

Five decisions where a reasonable engineer would have picked differently. In each case I chose
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
   `expiresAt` itself or it can serve a result a few seconds past its TTL.

4. **The worker as a separate process instead of a `worker_threads` thread.** A crash while
   parsing a bad PDF cannot take the HTTP server down with it, and the two can be restarted and
   scaled on their own. What I gave up: a second deployable to run, watch, and keep in sync with
   the first, and a slightly longer path from "job written" to "job started."

5. **Two providers, Anthropic for the LLM and OpenAI for embeddings.** Each does what it is best
   at, and the embedding model is the one the assignment names. What I gave up: two keys, two
   bills, and two services that can each be down. A memory or document query fails if OpenAI is
   unreachable even when Claude is fine.

The one I am least sure about is number 4. For one cohort's load the crash isolation may never
matter, and a `worker_threads` thread inside the agent process would be one fewer thing to deploy
and one fewer thing that can silently not be running. I chose the separate process because the
failure it prevents, a stalled upload with no error, is the kind that nobody notices until a
user complains. If it turns out to be more operational cost than it is worth, it is a small
change to move the loop into a thread.
