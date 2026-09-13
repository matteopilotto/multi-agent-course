/**
 * The jobs worker: its own process (`npm run worker`), same code as the agent service.
 * Poll → sweep stale rows → claim one job atomically → do it → flip the document.
 * A failure has no caller to reach, so it lands on the job and the document rows.
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import type { JobDoc } from '@lumina/contract';
import { env } from './env.js';
import { pingDb } from './db.js';
import { claimJob, completeJob, failJob, sweepStaleJobs } from './jobs.js';
import { findDocument, readUpload, setDocumentStatus } from './documents.js';
import { parseDocument } from './ingest.js';

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
  log.info(
    {
      docId,
      title: doc.title,
      pages: parsed.pages,
      pieces: parsed.pieces.length,
      locators: parsed.pieces.slice(0, 4).map((p) => p.locator),
      sample: parsed.pieces[0]?.text.slice(0, 80)
    },
    'parsed'
  );
  throw new Error('embedding not implemented yet');
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
