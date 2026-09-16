/**
 * The jobs worker: its own process (`npm run worker`), same code as the agent service.
 * Poll → sweep stale rows → claim one job atomically → do it → flip the document.
 * A failure has no caller to reach, so it lands on the job and the document rows.
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import type { ChunkDoc, JobDoc } from '@lumina/contract';
import { env } from './env.js';
import { pingDb } from './db.js';
import { claimJob, completeJob, failJob, sweepStaleJobs } from './jobs.js';
import { findDocument, readUpload, setDocumentStatus } from './documents.js';
import { parseDocument } from './ingest.js';
import { embedMany } from './embed.js';
import { deleteChunksOf, insertChunks } from './chunks.js';
import { vectorSearchChunks } from './retrieval.js';

const log = pino({ level: env.logLevel });
const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

/** Step 5 adds embed + write. Until then the job fails after parsing, and the log shows what the parser saw. */
async function handle(job: JobDoc): Promise<void> {
  const docId = String(job.payload.docId);
  const doc = await findDocument(docId);
  if (!doc) throw new Error(`document ${docId} not found`);

  await setDocumentStatus(docId, { status: 'parsing', pct: 5 });
  const parsed = await parseDocument(await readUpload(doc.fileId), doc.mimeType);
  log.info({ docId, title: doc.title, pages: parsed.pages, pieces: parsed.pieces.length }, 'parsed');
  if (parsed.pieces.length === 0) throw new Error('no text extracted (scanned PDF or empty file)');

  await setDocumentStatus(docId, {
    status: 'embedding',
    pct: 10,
    ...(parsed.pages !== undefined ? { pages: parsed.pages } : {})
  });
  const replaced = await deleteChunksOf(docId);
  if (replaced) log.warn({ docId, replaced }, 'retry: previous chunks removed before rewriting');

  let written = 0;
  for (let i = 0; i < parsed.pieces.length; i += env.embedBatchSize) {
    const batch = parsed.pieces.slice(i, i + env.embedBatchSize);
    const vectors = await embedMany(batch.map((p) => p.text));
    const rows: ChunkDoc[] = [];
    for (let j = 0; j < batch.length; j++) {
      const piece = batch[j];
      const embedding = vectors[j];
      if (!piece || !embedding) throw new Error(`batch mismatch at ${i + j}`);
      rows.push({
        _id: `${docId}:${i + j}`,
        docId,
        spaceId: doc.spaceId,
        userId: doc.userId,
        text: piece.text,
        locator: piece.locator,
        ord: i + j,
        embedding,
        createdAt: new Date()
      });
    }
    await insertChunks(rows);
    written += rows.length;
    // 10 → 90 across the batches; the last 10 points belong to the probe.
    await setDocumentStatus(docId, {
      pct: 10 + Math.round((written / parsed.pieces.length) * 80),
      chunks: written
    });
    log.info({ docId, written, of: parsed.pieces.length }, 'chunks written');
  }
  // Read-your-write probe: a chunk we wrote, queried by its own vector, must come back before we say `indexed`.
  const probeIndex = Math.floor(parsed.pieces.length / 2);
  const probeId = `${docId}:${probeIndex}`;
  const probeText = parsed.pieces[probeIndex]?.text;
  if (!probeText) throw new Error(`probe piece ${probeIndex} missing`);
  const [probeVector] = await embedMany([probeText]);
  if (!probeVector) throw new Error('probe embedding missing');

  const probeStart = Date.now();
  let found = false;
  let polls = 0;
  while (Date.now() - probeStart < env.indexProbeTimeoutMs) {
    polls++;
    const hits = await vectorSearchChunks(doc.spaceId, doc.userId, probeVector, 5);
    if (hits.some((h) => h.id === probeId)) {
      found = true;
      break;
    }
    await sleep(env.indexProbeIntervalMs);
  }
  const probeMs = Date.now() - probeStart;
  if (!found) {
    throw new Error(
      `chunk ${probeId} not searchable after ${probeMs} ms (${polls} probes): index still building?`
    );
  }
  log.info({ docId, probeId, probeMs, polls }, 'probe found the chunk');

  await setDocumentStatus(docId, { status: 'indexed', pct: 100, chunks: written, error: undefined });
}

async function runOne(job: JobDoc): Promise<void> {
  const docId = String(job.payload.docId);
  const t0 = Date.now();
  log.info({ jobId: job._id, docId, attempt: job.attempts }, 'job claimed');
  try {
    await handle(job);
    await completeJob(job._id);
    log.info({ jobId: job._id, docId, ms: Date.now() - t0 }, 'job done');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failJob(job._id, error);
    await setDocumentStatus(docId, { status: 'failed', error });
    log.error({ jobId: job._id, docId, attempt: job.attempts, ms: Date.now() - t0, err }, 'job failed');
  }
}

async function main(): Promise<void> {
  log.info(
    { workerId, pollMs: env.jobPollMs, staleMs: env.jobStaleMs, db: await pingDb() },
    'jobs worker up'
  );
  while (!stopping) {
    const swept = await sweepStaleJobs();
    if (swept.requeued || swept.failed) log.warn(swept, 'stale running jobs swept');
    const job = await claimJob(workerId);
    if (!job) {
      await sleep(env.jobPollMs);
      continue;
    }
    await runOne(job);
  }
  log.info('jobs worker stopped');
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'finishing the current job, then stopping');
    stopping = true;
  });
}

void main();
