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

export async function failJob(jobId: string, error: string): Promise<void> {
  await (await jobs()).updateOne({ _id: jobId }, { $set: { status: 'failed', error } });
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
