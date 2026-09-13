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
import { setDocumentStatus } from './documents.js';

const log = pino({ level: env.logLevel });
const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

/** Step 4 replaces this with the real ingest. Until then every job fails loud, which is the honest state. */
async function handle(job: JobDoc): Promise<void> {
  throw new Error(`ingest not implemented yet (job ${job._id})`);
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
