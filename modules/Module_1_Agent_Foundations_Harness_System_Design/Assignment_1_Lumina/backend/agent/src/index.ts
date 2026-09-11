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
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  newId,
  unresolvedCitations
} from '@lumina/contract';
import { costUsd } from './cost.js';
import { env } from './env.js';
import { pingDb } from './db.js';
import { openStream, send } from './sse.js';
import { runQuickLoop, newRunState } from './loop.js';
import { writeRunLog } from './runlog.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- POST /threads/:threadId/ask

app.post('/threads/:threadId/ask', async (req, res) => {
  const body = AskBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message, status: 400 });

  const requestId = req.header(REQUEST_HEADER) ?? newId('req');
  const startedAt = Date.now();
  const state = newRunState();
  const logBase = () => ({
    tokens: state.tokens.in + state.tokens.out,
    wallClockSec: (Date.now() - startedAt) / 1000,
    depth: 'quick' as const,
    toolCalls: state.toolCalls
  });

  openStream(res);
  try {
    const run = await runQuickLoop(body.data.query, res, startedAt, state);
    const dangling = unresolvedCitations(run.text, run.sources);
    if (dangling.length) log.warn({ requestId, dangling }, 'answer cites numbers that are not in sources');
    const cost = costUsd(state.tokens, run.searchCalls);
    send(res, 'done', {
      answerId: newId('ans'),
      latencyMs: Date.now() - startedAt,
      ttftMs: run.ttftMs,
      model: env.llmModel,
      tokens: state.tokens,
      costUsd: cost,
      searchCached: false,
      terminated: run.terminated,
      depth: 'quick'
    });
    writeRunLog(requestId, { ...logBase(), costUsd: cost, terminated: run.terminated });
  } catch (e) {
    log.error({ requestId, err: e }, 'ask failed');
    send(res, 'error', { status: 502, error: e instanceof Error ? e.message : String(e) });
    const searchCalls = state.toolCalls.filter((t) => t.name === 'web_search' && t.ok).length;
    writeRunLog(requestId, {
      ...logBase(),
      costUsd: costUsd(state.tokens, searchCalls),
      terminated: 'error'
    });
  }
  res.end();
});

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
    route.path === '/threads/:threadId/ask'
  )
    continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, notImplemented(`${route.method} ${route.path}`));
}

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err }, 'agent error');
  res.status(502).json({ error: err.message, status: 502 });
});

app.listen(env.port, () => {
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
