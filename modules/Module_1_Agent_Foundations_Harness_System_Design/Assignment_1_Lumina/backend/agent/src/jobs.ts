import { COLLECTIONS, type JobDoc } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

const jobs = async () => (await db()).collection<JobDoc>(COLLECTIONS.jobs);

export async function enqueueJob(job: JobDoc): Promise<void> {
  await (await jobs()).insertOne(job);
}

/**
 * The queue is this one call. Filter and update are applied atomically, so two workers
 * polling at the same instant cannot both win the same row. null means nothing to do.
 */
export async function claimJob(workerId: string): Promise<JobDoc | null> {
  return (await jobs()).findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

export async function completeJob(jobId: string): Promise<void> {
  await (await jobs()).updateOne({ _id: jobId }, { $set: { status: 'done' }, $unset: { error: '' } });
}

export type FailOutcome = 'requeued' | 'failed';

/**
 * A job that threw is not automatically dead. A retryable error goes back to `pending` while
 * attempts remain, so a provider's bad minute does not kill a document permanently. Anything
 * else fails at once, because retrying a bad key just fails three times instead of one.
 */
export async function failJob(jobId: string, error: string, retryable: boolean): Promise<FailOutcome> {
  const col = await jobs();
  const job = await col.findOne({ _id: jobId });
  const attempts = job?.attempts ?? env.jobMaxAttempts;
  if (retryable && attempts < env.jobMaxAttempts) {
    await col.updateOne(
      { _id: jobId },
      { $set: { status: 'pending', error }, $unset: { claimedAt: '', workerId: '' } }
    );
    return 'requeued';
  }
  await col.updateOne({ _id: jobId }, { $set: { status: 'failed', error } });
  return 'failed';
}

/**
 * A `running` row with a stale claimedAt belongs to a worker that died mid-job. Give it
 * back to the queue while it has attempts left; otherwise fail it, so a file that crashes
 * the parser every time cannot circulate forever. Returns how many rows were touched.
 */
export async function sweepStaleJobs(): Promise<{ requeued: number; failed: number }> {
  const col = await jobs();
  const staleBefore = new Date(Date.now() - env.jobStaleMs);
  const stale = { status: 'running' as const, claimedAt: { $lt: staleBefore } };
  const failed = await col.updateMany(
    { ...stale, attempts: { $gte: env.jobMaxAttempts } },
    { $set: { status: 'failed', error: `abandoned after ${env.jobMaxAttempts} attempts` } }
  );
  const requeued = await col.updateMany(stale, {
    $set: { status: 'pending' },
    $unset: { claimedAt: '', workerId: '' }
  });
  return { requeued: requeued.modifiedCount, failed: failed.modifiedCount };
}

/**
 * Worker liveness. The agent cannot see the worker's process (a separate machine on Fly), so
 * the worker writes a beat here and /health reads the newest one. Not in the contract's
 * COLLECTIONS (a provided package), hence the local name. One row per worker process; the
 * newest beat is the one that counts, so rows left by crashed processes are harmless.
 */
type WorkerBeat = { _id: string; beatAt: Date };
const workers = async () => (await db()).collection<WorkerBeat>('workers');

export async function heartbeat(workerId: string): Promise<void> {
  await (await workers()).updateOne({ _id: workerId }, { $set: { beatAt: new Date() } }, { upsert: true });
}

export async function lastHeartbeat(): Promise<Date | null> {
  const [row] = await (await workers()).find().sort({ beatAt: -1 }).limit(1).toArray();
  return row?.beatAt ?? null;
}
