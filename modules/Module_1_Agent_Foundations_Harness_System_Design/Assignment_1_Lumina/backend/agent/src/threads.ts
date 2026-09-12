import { COLLECTIONS, newId, type ThreadDoc } from '@lumina/contract';
import { db } from './db.js';

const threads = async () => (await db()).collection<ThreadDoc>(COLLECTIONS.threads);

/** Insert one thread row and return its id. `createdAt` is a real Date so Mongo can sort on it. */
export async function createThread(userId: string, title?: string): Promise<string> {
  const doc: ThreadDoc = {
    _id: newId('thr'),
    userId,
    title: title ?? 'New thread',
    createdAt: new Date()
  };
  await (await threads()).insertOne(doc);
  return doc._id;
}
