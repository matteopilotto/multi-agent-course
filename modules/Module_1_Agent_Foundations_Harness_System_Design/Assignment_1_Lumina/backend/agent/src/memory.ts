import { COLLECTIONS, SEARCH_INDEXES, newId, type Memory, type MemoryDoc } from '@lumina/contract';
import { db } from './db.js';
import { embed } from './embed.js';
import { env } from './env.js';

const memories = async () => (await db()).collection<MemoryDoc>(COLLECTIONS.memories);

export type Recalled = { id: string; text: string; score: number };

/** Embed, then insert. The row is the memory: nothing is remembered that GET /memory cannot show. */
export async function saveMemory(userId: string, text: string, sourceThread?: string): Promise<string> {
  const doc: MemoryDoc = {
    _id: newId('mem'),
    userId,
    text,
    embedding: await embed(text),
    ...(sourceThread ? { sourceThread } : {}),
    createdAt: new Date()
  };
  await (await memories()).insertOne(doc);
  return doc._id;
}

/** Top-k memories for this user by cosine similarity. The userId filter lives INSIDE $vectorSearch. */
export async function recallMemory(userId: string, query: string, k = 5): Promise<Recalled[]> {
  const queryVector = await embed(query);
  const col = await memories();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    // Local mongod has no vector index: score every row of this user in Node. Fine for memories, never for chunks.
    const rows = await col.find({ userId }).toArray();
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
    return rows
      .map((m) => ({ id: m._id, text: m.text, score: dot(queryVector, m.embedding) })) // OpenAI vectors are unit length, so dot = cosine
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  const rows = await col
    .aggregate<Recalled>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.memoriesVector,
          path: 'embedding',
          queryVector,
          numCandidates: Math.max(50, k * 10),
          limit: k,
          filter: { userId: { $eq: userId } }
        }
      },
      { $project: { _id: 0, id: '$_id', text: 1, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
  return rows;
}

/** The contract shape for GET /memory: newest first, no embeddings on the wire. */
export async function listMemories(userId: string): Promise<Memory[]> {
  const rows = await (await memories()).find({ userId }).sort({ createdAt: -1 }).toArray();
  return rows.map((m) => ({
    id: m._id,
    text: m.text,
    ...(m.sourceThread ? { sourceThread: m.sourceThread } : {}),
    createdAt: new Date(m.createdAt).toISOString()
  }));
}

/** false when the id does not exist or belongs to someone else: both are a 404 to the caller. */
export async function deleteMemory(userId: string, memoryId: string): Promise<boolean> {
  const r = await (await memories()).deleteOne({ _id: memoryId, userId });
  return r.deletedCount === 1;
}
