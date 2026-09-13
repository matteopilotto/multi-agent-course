import { COLLECTIONS, type ChunkDoc } from '@lumina/contract';
import { db } from './db.js';

const chunks = async () => (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);

/** A retried job rewrites its chunks; without this a second attempt would double them. */
export async function deleteChunksOf(docId: string): Promise<number> {
  return (await (await chunks()).deleteMany({ docId })).deletedCount;
}

export async function insertChunks(rows: ChunkDoc[]): Promise<void> {
  if (rows.length) await (await chunks()).insertMany(rows);
}

export async function countChunksOf(docId: string): Promise<number> {
  return (await chunks()).countDocuments({ docId });
}
