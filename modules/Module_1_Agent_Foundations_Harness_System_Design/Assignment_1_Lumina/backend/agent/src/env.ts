import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5',
  llmModelResearch: process.env.LLM_MODEL_RESEARCH ?? 'claude-haiku-4-5-20251001',
  llmModelPlanner: process.env.LLM_MODEL_PLANNER ?? 'claude-haiku-4-5-20251001',

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),

  // Jobs worker: how often it polls, when a `running` row counts as abandoned, how many tries a document gets.
  jobPollMs: num(process.env.JOB_POLL_MS, 1000),
  jobStaleMs: num(process.env.JOB_STALE_MS, 5 * 60 * 1000),
  jobMaxAttempts: num(process.env.JOB_MAX_ATTEMPTS, 3),

  // RAG: the widest a chunk may be before it is split on line boundaries. Declared, not hard-coded.
  chunkMaxChars: num(process.env.CHUNK_MAX_CHARS, 1500),

  // Hybrid retrieval, declared not hard-coded (SPEC 5.4). ragTopK is what search_documents
  // returns and what recall@5 is measured against. Each branch fetches ragCandidates FIRST,
  // because RRF can only fuse what it was shown. rrfK damps the rank gap: at 1 whoever is
  // first anywhere wins, at 10000 only membership counts, 60 is the convention in between.
  ragTopK: num(process.env.RAG_TOP_K, 5),
  ragCandidates: num(process.env.RAG_CANDIDATES, 20),
  rrfK: num(process.env.RRF_K, 60),
  // A docs-only research phase has no "two pages fetched" exit, so the harness ends it: after
  // this many search_documents calls (the pre-search counts), or sooner if one finds nothing new.
  maxDocSearches: num(process.env.MAX_DOC_SEARCHES, 3),

  // How long the worker waits for a freshly written chunk to become searchable before it fails the document.
  indexProbeTimeoutMs: num(process.env.INDEX_PROBE_TIMEOUT_MS, 60000),
  indexProbeIntervalMs: num(process.env.INDEX_PROBE_INTERVAL_MS, 1000),

  // Chunks per embeddings request. OpenAI accepts up to 2048 inputs; 64 keeps one failure small.
  embedBatchSize: num(process.env.EMBED_BATCH_SIZE, 64),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),

  // A3: the model may ask for any number of tool blocks in one turn; the harness executes at
  // most this many of the same tool, so a fetch storm cannot outrun `maxConsecutiveSameTool`.
  maxSameToolInARow: num(process.env.MAX_SAME_TOOL_IN_A_ROW, 4),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;
