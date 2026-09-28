/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * What is already here: the server, CORS, the request id, the pino request log, /health
 * (which nests the agent service's health), a 501 for every contract route, and the
 * static hosting of web/dist. That is deliberately the boring half.
 *
 * What you build (backend/gateway/, see README Part 2):
 *   1. X-User-Id enforcement           → 401 without it, on every route but /health
 *   2. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   3. a per-user rate limit           → 429
 *   4. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   5. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER,
  AskBody,
  CreateSpaceBody,
  CreateThreadBody
} from '@lumina/contract';
import { env } from './env.js';
import type { z } from 'zod';
import { sseHeaders, sseSend } from './sse.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
);

// ---------------------------------------------------------------- X-User-Id (401)

/**
 * Only contract routes need the header. The UI's own files are fetched by a browser that
 * sends none, and a CORS preflight never carries custom headers, so this runs after cors()
 * and is registered per route from the contract's table rather than on every path.
 */
const requireUser: express.RequestHandler = (req, res, next) => {
  const userId = req.header(USER_HEADER)?.trim();
  if (!userId) {
    res.status(401).json({
      error: `missing ${USER_HEADER} header`,
      status: 401,
      requestId: String(res.locals.requestId)
    });
    return;
  }
  res.locals.userId = userId;
  next();
};

for (const route of ROUTES) {
  if (!route.auth) continue;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, requireUser);
}

// ---------------------------------------------------------------- rate limit (429)

/**
 * Per user, on the two routes that spend: an ask calls paid providers, an upload is parsed and
 * embedded. Reads and thread/space creation are cheap, and the UI polls documents every 1.5 s
 * (the bench every 1.2 s), so counting them would 429 a user for watching an upload and fail
 * the bench's error budget. A token bucket: bursts up to RATE_LIMIT_PER_MINUTE, refilled at
 * that rate. In memory, so per gateway process; a second machine needs a shared store.
 */
const buckets = new Map<string, { tokens: number; at: number }>();
const refillPerMs = env.rateLimitPerMinute / 60_000;
const topUp = (b: { tokens: number; at: number }, now: number) =>
  Math.min(env.rateLimitPerMinute, b.tokens + (now - b.at) * refillPerMs);

const rateLimit: express.RequestHandler = (_req, res, next) => {
  const userId = String(res.locals.userId);
  const now = Date.now();
  const bucket = buckets.get(userId) ?? { tokens: env.rateLimitPerMinute, at: now };
  bucket.tokens = topUp(bucket, now);
  bucket.at = now;
  buckets.set(userId, bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    next();
    return;
  }
  const retryAfterSec = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
  const requestId = String(res.locals.requestId);
  log.warn({ requestId, userId, retryAfterSec }, 'rate limited');
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: `rate limit: ${env.rateLimitPerMinute} asks and uploads per minute, retry in ${retryAfterSec} s`,
    status: 429,
    resetsAt: new Date(now + retryAfterSec * 1000).toISOString(),
    requestId
  });
};

// A full bucket is the same as no bucket; dropping them keeps the map from growing forever.
setInterval(() => {
  const now = Date.now();
  for (const [userId, bucket] of buckets) {
    if (topUp(bucket, now) >= env.rateLimitPerMinute) buckets.delete(userId);
  }
}, 60_000).unref();

app.post('/threads/:threadId/ask', rateLimit);
app.post('/spaces/:spaceId/documents', rateLimit);

// JSON everywhere except the multipart upload route, which your handler owns.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

// ---------------------------------------------------------------- validation (400)

/**
 * The contract's own schemas, so gateway and UI cannot drift. The parsed body replaces the
 * raw one: defaults are filled (depth quick, mode auto) and unknown keys are stripped, so
 * the agent receives exactly what was validated.
 */
const validate =
  (schema: z.ZodTypeAny): express.RequestHandler =>
  (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        status: 400,
        requestId: String(res.locals.requestId)
      });
      return;
    }
    req.body = parsed.data;
    next();
  };

app.post('/threads', validate(CreateThreadBody));
app.post('/threads/:threadId/ask', validate(AskBody));
app.post('/spaces', validate(CreateSpaceBody));

// ---------------------------------------------------------------- /health (implemented)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- proxy (JSON routes)

/** Response headers worth relaying. Everything else is per-hop or already undone by fetch. */
const RELAYED = ['content-type', 'retry-after'] as const;

/**
 * Forward one request to the agent and relay its answer untouched: its 404, its 413, its
 * 429 and its 502 are already the right answer. The gateway only speaks for itself when the
 * request to the agent fails, and that is a 502, never a crash (the async handler catches
 * its own rejection, because Express 4 will not).
 *
 * `json` re-serializes the body validated in step 2; `stream` pipes the raw request through
 * unparsed, keeping its content-type, whose multipart boundary the agent needs to split it.
 */
const proxy =
  (body: 'json' | 'stream'): express.RequestHandler =>
  async (req, res) => {
    const hasJson = body === 'json' && req.method === 'POST';
    const contentType =
      body === 'stream' ? req.header('content-type') : hasJson ? 'application/json' : undefined;
    try {
      const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
        method: req.method,
        headers: {
          [USER_HEADER]: String(res.locals.userId),
          [REQUEST_HEADER]: String(res.locals.requestId),
          ...(contentType ? { 'content-type': contentType } : {})
        },
        ...(body === 'stream'
          ? { body: req, duplex: 'half' as const }
          : { body: hasJson ? JSON.stringify(req.body ?? {}) : undefined }),
        signal: AbortSignal.timeout(env.agentTimeoutMs)
      });
      for (const h of RELAYED) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.status(upstream.status);
      if (upstream.status === 204) {
        res.end();
        return;
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      log.error({ err, requestId: res.locals.requestId, route: req.originalUrl }, 'agent request failed');
      res.status(502).json({
        error: `agent request failed: ${(err as Error).message}`,
        status: 502,
        requestId: String(res.locals.requestId)
      });
    }
  };

// ---------------------------------------------------------------- /ask: SSE pass-through

/** The agent's own last word on a stream. A stream that ends without one did not finish. */
const SSE_TERMINAL = /^event: (done|error)$/m;

/**
 * Relays the agent's SSE frames as they arrive, whole frames only: a chunk can end inside a
 * frame, and a partial frame followed by our own `error` would reach the browser as broken
 * JSON. Refusals that come before the stream (404, the deep-cap 429, 502) are plain JSON and
 * are relayed like any other route. Once the 200 is on the wire, a failure can only be an
 * `error` event. No timeout: a deep search is allowed 240 s.
 */
const askStream: express.RequestHandler = async (req, res) => {
  const requestId = String(res.locals.requestId);
  // res 'close', not req 'close': the request side closes as soon as its body has been read.
  const upstreamAbort = new AbortController();
  res.on('close', () => upstreamAbort.abort());
  let pending = '';
  let ended = false;
  try {
    const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: {
        [USER_HEADER]: String(res.locals.userId),
        [REQUEST_HEADER]: requestId,
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body),
      signal: upstreamAbort.signal
    });
    const isStream =
      upstream.ok && (upstream.headers.get('content-type') ?? '').startsWith('text/event-stream');
    if (!isStream || !upstream.body) {
      for (const h of RELAYED) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    sseHeaders(res);
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      const cut = pending.lastIndexOf('\n\n');
      if (cut === -1) continue;
      const frames = pending.slice(0, cut + 2);
      pending = pending.slice(cut + 2);
      if (SSE_TERMINAL.test(frames)) ended = true;
      res.write(frames);
    }
    if (!ended) throw new Error('agent closed the stream without a done or error event');
    res.end();
  } catch (err) {
    if (upstreamAbort.signal.aborted) return; // the browser left; there is nobody to tell
    const message = `agent request failed: ${(err as Error).message}`;
    log.error({ err, requestId }, 'agent request failed');
    if (!res.headersSent) {
      res.status(502).json({ error: message, status: 502, requestId });
      return;
    }
    // The 200 and the headers are already sent; only an event can carry the failure now.
    sseSend(res, 'error', { status: 502, error: message });
    res.end();
  }
};

// ---------------------------------------------------------------- everything else: 501

/**
 * Every contract route answers 501 until you implement it. The UI renders that as
 * "not implemented yet", so the interface is your progress bar: each route you finish
 * lights up a piece of the product.
 */
const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
  res.status(501).json({
    error: `not implemented yet: ${route}. Build it in backend/gateway/src/.`,
    status: 501,
    requestId: String(res.locals.requestId)
  });
};

/** Routes that are not plain JSON, still 501 until their pass-through is built. */
const NOT_YET = new Set(['GET /evals/report.json']);

const ASK = 'POST /threads/:threadId/ask';
/** The one route whose body is streamed through unparsed (multipart, up to 25 MB). */
const UPLOAD = 'POST /spaces/:spaceId/documents';

const handlerFor = (key: string): express.RequestHandler =>
  NOT_YET.has(key)
    ? notImplemented(key)
    : key === ASK
      ? askStream
      : proxy(key === UPLOAD ? 'stream' : 'json');

for (const route of ROUTES) {
  if (route.path === '/health') continue;
  const key = `${route.method} ${route.path}`;
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, handlerFor(key));
}

// ---------------------------------------------------------------- static UI

// In production the gateway serves the built UI, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
// body-parser's own failures are the exception: malformed or oversized JSON is the caller's
// fault, and calling it "upstream" would send someone debugging the agent for nothing.
app.use(
  (
    err: Error & { type?: string; status?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const requestId = String(res.locals.requestId);
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      const status = err.status ?? 400;
      res.status(status).json({ error: err.message, status, requestId });
      return;
    }
    log.error({ err, requestId }, 'gateway error');
    res.status(502).json({ error: err.message, status: 502, requestId });
  }
);

app.listen(env.port, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up — every route but /health returns 501 until you build it'
  );
});
