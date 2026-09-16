import { MongoClient, type Db } from 'mongodb';
import { env } from './env.js';

let clientPromise: Promise<MongoClient> | null = null;

/**
 * One client per process. Cache the promise rather than the client: concurrent callers share
 * one connect, and a failed connect is forgotten so the next call retries instead of reusing
 * a dead client. Assigning the client before connect() resolved left this process permanently
 * `db: down` after one Atlas hiccup, which is exactly what it did when the IP allowlist went stale.
 */
export async function db(): Promise<Db> {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');
  clientPromise ??= new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000 })
    .connect()
    .catch((err: unknown) => {
      clientPromise = null;
      throw err;
    });
  return (await clientPromise).db(env.mongoDb);
}

export async function pingDb(): Promise<'ok' | 'down'> {
  try {
    await (await db()).command({ ping: 1 });
    return 'ok';
  } catch {
    return 'down';
  }
}
