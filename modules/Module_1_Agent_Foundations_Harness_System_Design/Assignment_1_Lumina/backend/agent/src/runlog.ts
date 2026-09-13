import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLLECTIONS, RequestDoc, RunDoc, RunLog } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

const runs = async () => (await db()).collection<RunDoc>(COLLECTIONS.runs);
const requests = async () => (await db()).collection<RequestDoc>(COLLECTIONS.requests);

/**
 * One run record per answer. Mongo is the system of record (export-runs.mjs and /stats read
 * it); the file is what quality/check.mjs reads locally. Validated against the contract
 * first, so drift fails here and not in the grader.
 */
export async function recordRun(doc: RunDoc): Promise<void> {
  RunDoc.parse(doc);
  if (env.nodeEnv !== 'production') {
    // zod strips keys it does not know, so this is the file shape without the Mongo-only fields.
    const file = RunLog.parse(doc);
    writeFileSync(resolve(env.runsDir, `${doc.requestId}.json`), JSON.stringify(file, null, 2));
  }
  await (await runs()).insertOne(doc);
}

/** One row per request: the numbers /stats sums. `status` is what the caller actually got. */
export async function recordRequest(doc: RequestDoc): Promise<void> {
  RequestDoc.parse(doc);
  await (await requests()).insertOne(doc);
}
