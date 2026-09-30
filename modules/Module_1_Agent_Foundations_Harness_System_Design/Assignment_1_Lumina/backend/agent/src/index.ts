/**
 * LUMINA agent service — the AI backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 * This is where the real work is. Provider keys live only in this process.
 *
 * What is already here: the server, /health (Mongo ping + which model, provider and
 * vector backend are live), and a 501 for every other route.
 *
 * What you build (README Part 1, in this order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index),
 *      key = sha256(normalized query + provider). searchCached only when every hit.
 *   3. threads + messages, so a follow-up sees the thread.
 *   4. memory: save_memory / recall_memory over the memories vector index; GET /memory,
 *      DELETE /memory/:id.
 *   5. the run log: one runs/<requestId>.json per answer, in the RunLog shape from the
 *      contract. Ten lines. The gates read it, so it is not optional.
 *   6. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   7. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   8. DEEP search (depth: "deep"): plan_research decomposes the question into 3–6
 *      sub-questions, you stream a `plan` event BEFORE retrieving anything, research each
 *      sub-question, then merge the results into ONE citation numbering and synthesise.
 *      Every trace step and every source carries the subQuestion it served. Deep runs
 *      under the wider caps (maxToolCallsDeep, maxWallClockSecDeep) and behind
 *      DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *     Never a try/catch that returns a plausible answer. (Live Translate served English
 *     for weeks because of exactly that catch.)
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research,
 *     however much the model would like to. Deep costs several times more, and a product
 *     that escalates itself is a product with an unbounded bill.
 */
import express from 'express';
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import {
  AskBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER,
  newId,
  unresolvedCitations,
  DoneEvent,
  ListMemoryResponse,
  CreateSpaceBody,
  type CreateSpaceResponse,
  type ListSpacesResponse,
  type RequestDoc,
  type RunDoc,
  type Terminated,
  ACCEPTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  type UploadDocumentResponse,
  type ListDocumentsResponse
} from '@lumina/contract';
import {
  createThread,
  findThread,
  listThreads,
  threadMessages,
  recentMessages,
  appendMessage,
  titleFromFirstQuery
} from './threads.js';
import { costUsd } from './cost.js';
import { env } from './env.js';
import { pingDb } from './db.js';
import { loadPageChecks } from './pagecheck.js';
import { lastHeartbeat } from './jobs.js';
import { openStream, send } from './sse.js';
import { providerSearchCalls, runQuickLoop, newRunState, HISTORY_MAX_TURNS } from './loop.js';
import { recordRequest, recordRun } from './runlog.js';
import { listMemories, deleteMemory } from './memory.js';
import { createSpace, listSpaces } from './spaces.js';
import multer from 'multer';
import { extname } from 'node:path';
import { findSpace } from './spaces.js';
import { createDocument, listDocuments } from './documents.js';
import { getStats } from './stats.js';
import { reserveDeep, type DeepSlot } from './spend.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

/**
 * Express 4 does not route a rejected promise from an async handler to the error middleware:
 * it becomes an unhandled rejection and Node exits. One slow Atlas connect killed the whole
 * agent this way. Every async route goes through here, so a failure is a 502, not a dead process.
 */
const safe =
  <P extends Record<string, string> = Record<string, string>>(
    h: (req: express.Request<P>, res: express.Response) => Promise<unknown>
  ): express.RequestHandler<P> =>
  (req, res, next) => {
    h(req, res).catch(next);
  };

// ---------------------------------------------------------------- /health (implemented)

/** Three missed beats. A dead worker means uploads never index: degraded, not down. */
const WORKER_STALE_MS = 15_000;

app.get('/health', async (_req, res) => {
  const [dbStatus, beatAt] = await Promise.all([pingDb(), lastHeartbeat().catch(() => null)]);
  const workerStatus: 'ok' | 'down' =
    beatAt && Date.now() - beatAt.getTime() < WORKER_STALE_MS ? 'ok' : 'down';
  const body: HealthResponse & { worker: { status: 'ok' | 'down'; lastBeatAt: string | null } } = {
    status: dbStatus === 'ok' && workerStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' },
    worker: { status: workerStatus, lastBeatAt: beatAt?.toISOString() ?? null }
  };
  // A dead worker is a partial outage: 200, so Fly and the bench do not take the agent for dead.
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- GET /stats

app.get(
  '/stats',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    res.json(await getStats(userId));
  })
);

// ---------------------------------------------------------------- POST /threads

/** The gateway will reject a missing header before it gets here; the agent still refuses, because every row needs an owner. */
const userIdOf = (req: express.Request): string | undefined => req.header(USER_HEADER)?.trim() || undefined;

app.post(
  '/threads',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const body = CreateThreadBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.message, status: 400 });
    const threadId = await createThread(userId, body.data.title);
    res.status(201).json({ threadId });
  })
);

app.get(
  '/threads',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    res.json({ threads: await listThreads(userId) });
  })
);

app.get(
  '/threads/:threadId',
  safe<{ threadId: string }>(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const thread = await findThread(userId, req.params.threadId);
    if (!thread) return res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
    res.json({ threadId: thread._id, title: thread.title, messages: await threadMessages(thread._id) });
  })
);

// ---------------------------------------------------------------- POST /threads/:threadId/ask

app.post(
  '/threads/:threadId/ask',
  safe<{ threadId: string }>(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const body = AskBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message, status: 400 });
    // Before the stream opens: a status code can still carry the failure here, not after.
    const thread = await findThread(userId, req.params.threadId);
    if (!thread) return res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
    // A Space that is not yours is a 404 here too, for the same reason: once the SSE headers are
    // sent, a 200 is already on the wire and the failure can only be an `error` event.
    if (body.data.spaceId && !(await findSpace(userId, body.data.spaceId))) {
      return res.status(404).json({ error: `no space ${body.data.spaceId}`, status: 404 });
    }

    const requestId = req.header(REQUEST_HEADER) ?? newId('req');
    const startedAt = Date.now();
    const state = newRunState();
    const query = body.data.query;
    // The gear requested is the gear that runs: the server never upgrades, and a failed plan throws
    // instead of downgrading. So it is read here, once, and the error path logs it too — a deep run
    // that failed still spent deep money and still counts toward the daily cap.
    const depth = body.data.depth;

    const logBase = () => ({
      tokens: state.tokens.in + state.tokens.out,
      wallClockSec: (Date.now() - startedAt) / 1000,
      depth: depth,
      toolCalls: state.toolCalls
    });

    const route = 'POST /threads/:threadId/ask';
    /**
     * The evidence: a runs row (plus the local file) and a requests row. Written after the
     * response is committed, so a failure here is logged and never thrown: the status code
     * has already left the building.
     */
    const record = async (terminated: Terminated, cost: number, status: number, answerId?: string) => {
      const createdAt = new Date();
      const run: RunDoc = {
        ...logBase(),
        costUsd: cost,
        terminated,
        requestId,
        userId,
        threadId: thread._id,
        query,
        ...(answerId ? { answerId } : {}),
        createdAt
      };
      const request: RequestDoc = {
        requestId,
        userId,
        route,
        status,
        ms: Date.now() - startedAt,
        tokensIn: state.tokens.in,
        tokensOut: state.tokens.out,
        costUsd: cost,
        toolCalls: state.toolCalls.length,
        terminated,
        depth: depth,
        createdAt
      };
      try {
        await Promise.all([recordRun(run), recordRequest(request)]);
      } catch (err) {
        log.error({ requestId, err }, 'evidence write failed: runs/requests rows missing for this answer');
      }
    };

    // Read the history BEFORE appending this turn, or the question shows up twice.
    // Only the turns the loop can use: the whole thread is a download that grows with every ask.
    const history = await recentMessages(thread._id, HISTORY_MAX_TURNS);

    // The spend gate, here and not at the gateway: a cap on the edge is skipped by calling this
    // service directly. Before the stream opens, so the refusal is a real 429 and not an SSE event.
    // A refused request is never recorded, so it does not spend the allowance it was refused for.
    let slot: DeepSlot | undefined;
    if (body.data.depth === 'deep') {
      const reserved = await reserveDeep(userId);
      if ('resetsAt' in reserved) {
        log.warn({ requestId, userId, cap: env.deepDailyCap }, 'deep search refused: daily cap reached');
        res.setHeader('Retry-After', String(Math.ceil((Date.parse(reserved.resetsAt) - Date.now()) / 1000)));
        return res.status(429).json({
          error: `deep search daily cap reached (${env.deepDailyCap} per day)`,
          status: 429,
          resetsAt: reserved.resetsAt,
          requestId
        });
      }
      slot = reserved;
    }

    // The user turn and the title are writes nothing reads until the next request, so they run
    // alongside the planner instead of in front of it: two M0 round trips off deep's time to plan.
    // Awaited before `done`, because `done` promises a follow-up will see this turn.
    const saved = Promise.all([
      appendMessage({ threadId: thread._id, userId, role: 'user', content: query, sources: [] }),
      titleFromFirstQuery(thread._id, query)
    ]);
    saved.catch(() => {}); // marks it handled so Node does not exit; the real await below still throws

    openStream(res);
    try {
      const run = await runQuickLoop(
        query,
        res,
        startedAt,
        state,
        {
          userId,
          threadId: thread._id,
          mode: body.data.mode,
          depth: body.data.depth,
          spaceId: body.data.spaceId
        },
        history
      );
      const dangling = unresolvedCitations(run.text, run.sources);
      if (dangling.length) log.warn({ requestId, dangling }, 'answer cites numbers that are not in sources');
      const cost = costUsd(state.usage, run.searchCalls);
      const done: DoneEvent = {
        answerId: newId('ans'),
        latencyMs: Date.now() - startedAt,
        ttftMs: run.ttftMs,
        model: env.llmModel,
        tokens: state.tokens,
        costUsd: cost,
        searchCached: run.searchCached,
        terminated: run.terminated,
        depth,
        subQuestions: run.plan?.subQuestions.length ?? 0
      };
      // Authoritative state first: `done` promises a follow-up will see this turn. The user turn
      // lands before the answer, and a failed write ends the run here instead of behind a `done`.
      await saved;
      await appendMessage({
        threadId: thread._id,
        userId,
        role: 'assistant',
        content: run.text,
        sources: run.sources,
        answerId: done.answerId,
        done,
        ...(run.plan ? { subQuestions: run.plan.subQuestions } : {}) // the plan, so the answer stays explainable
      });
      send(res, 'done', done);
      log.info(
        {
          requestId,
          toolCalls: state.toolCalls.length,
          terminated: run.terminated,
          depth,
          tokens: state.tokens,
          usage: state.usage, // the per-model split the bill was computed from
          costUsd: cost,
          searchCached: run.searchCached,
          ttftMs: run.ttftMs,
          latencyMs: done.latencyMs
        },
        'answer'
      );
      await record(run.terminated, cost, 200, done.answerId);
    } catch (e) {
      const cost = costUsd(state.usage, providerSearchCalls(state));
      log.error(
        {
          requestId,
          err: e,
          toolCalls: state.toolCalls.length,
          terminated: 'error',
          tokens: state.tokens,
          costUsd: cost
        },
        'ask failed'
      );
      send(res, 'error', { status: 502, error: e instanceof Error ? e.message : String(e) });
      await record('error', cost, 502);
    } finally {
      slot?.release(); // after record(): the requests row exists before the slot is given back
    }
    res.end();
  })
);

// ---------------------------------------------------------------- GET /memory · DELETE /memory/:memoryId

app.get(
  '/memory',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const body: ListMemoryResponse = { memories: await listMemories(userId) };
    res.json(body);
  })
);

app.delete(
  '/memory/:memoryId',
  safe<{ memoryId: string }>(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const gone = await deleteMemory(userId, req.params.memoryId);
    if (!gone) return res.status(404).json({ error: `no memory ${req.params.memoryId}`, status: 404 });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- POST /spaces · GET /spaces

app.post(
  '/spaces',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const body = CreateSpaceBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: body.error.message, status: 400 });
    const space = await createSpace(userId, body.data.name);
    const out: CreateSpaceResponse = { spaceId: space._id, name: space.name };
    res.status(201).json(out);
  })
);

app.get(
  '/spaces',
  safe(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const out: ListSpacesResponse = { spaces: await listSpaces(userId) };
    res.json(out);
  })
);

// ---------------------------------------------------------------- POST · GET /spaces/:spaceId/documents

/** In memory: the request holds the bytes only long enough to hand them to GridFS. */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

const BY_EXT: Record<string, (typeof ACCEPTED_UPLOAD_TYPES)[number]> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain'
};
/** Browsers lie about .md ("application/octet-stream"); the extension is the tie-breaker. */
const acceptedType = (mime: string, filename: string) =>
  (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(mime)
    ? (mime as (typeof ACCEPTED_UPLOAD_TYPES)[number])
    : BY_EXT[extname(filename).toLowerCase()];

app.post(
  '/spaces/:spaceId/documents',
  safe<{ spaceId: string }>(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const space = await findSpace(userId, req.params.spaceId);
    if (!space) return res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });

    // Run multer by hand so its size error becomes a 413 instead of falling into the 502 handler.
    const parsed = await new Promise<Error | null>((resolve) =>
      upload.single('file')(req, res, (e) => resolve(e ?? null))
    );
    if (parsed) {
      const status = (parsed as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: parsed.message, status });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'multipart field "file" is required', status: 400 });
    const mimeType = acceptedType(file.mimetype, file.originalname);
    if (!mimeType) return res.status(400).json({ error: `unsupported type ${file.mimetype}`, status: 400 });

    const docId = await createDocument({
      userId,
      spaceId: space._id,
      title: file.originalname,
      mimeType,
      buffer: file.buffer
    });

    const out: UploadDocumentResponse = { docId, status: 'pending' };
    res.status(202).json(out);
  })
);

app.get(
  '/spaces/:spaceId/documents',
  safe<{ spaceId: string }>(async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: `missing ${USER_HEADER}`, status: 401 });
    const space = await findSpace(userId, req.params.spaceId);
    if (!space) return res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });
    const out: ListDocumentsResponse = { documents: await listDocuments(userId, space._id) };
    res.json(out);
  })
);

// ---------------------------------------------------------------- everything else: 501

const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res
    .status(501)
    .json({ error: `not implemented yet: ${route}. Build it in backend/agent/src/.`, status: 501 });
};

for (const route of ROUTES) {
  if (
    route.path === '/health' ||
    route.path === '/evals/report.json' ||
    route.path === '/stats' ||
    route.path.startsWith('/threads') ||
    route.path.startsWith('/memory') ||
    route.path.startsWith('/spaces')
  )
    continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  if (res.headersSent) return next(err); // mid-stream: the 200 is gone, Express closes the connection
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
  // Open the Mongo client now, not on the first ask: the handshake took 1.6 s inside a request's ttft window.
  void pingDb().then((status) => log.info({ db: status }, 'mongo connection warmed'));
  loadPageChecks().then(
    (n) => log.info({ verdicts: n }, 'page checks loaded'),
    (err: unknown) => log.error({ err }, 'page checks not loaded; pages are read unchecked until checked again')
  );
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: {
          toolCalls: env.maxToolCallsDeep,
          wallClockSec: env.maxWallClockSecDeep,
          dailyCap: env.deepDailyCap
        }
      }
    },
    'agent up — every route but /health returns 501 until you build it'
  );
});
