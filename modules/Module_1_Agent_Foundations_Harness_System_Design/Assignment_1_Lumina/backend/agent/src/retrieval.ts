import { COLLECTIONS, SEARCH_INDEXES, type ChunkDoc, type Locator } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

const chunks = async () => (await db()).collection<ChunkDoc>(COLLECTIONS.chunks);

export type ChunkHit = { id: string; docId: string; text: string; locator: Locator; score: number };

/**
 * Dense retrieval over one Space. The spaceId filter lives INSIDE $vectorSearch: a later
 * $match would rank another Space's chunks first and then hide them, which quietly breaks recall.
 * Used by the worker's probe today and by search_documents next.
 */
export async function vectorSearchChunks(
  spaceId: string,
  userId: string,
  queryVector: number[],
  k: number
): Promise<ChunkHit[]> {
  const col = await chunks();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    // Local mongod has no vector index: score the Space's chunks in Node. Fine to a few thousand chunks.
    const rows = await col.find({ spaceId, userId }).toArray();
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
    return rows
      .map((c) => ({
        id: c._id,
        docId: c.docId,
        text: c.text,
        locator: c.locator,
        score: dot(queryVector, c.embedding)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  return col
    .aggregate<ChunkHit>([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.chunksVector,
          path: 'embedding',
          queryVector,
          numCandidates: Math.max(100, k * 20),
          limit: k,
          filter: { spaceId: { $eq: spaceId }, userId: { $eq: userId } }
        }
      },
      {
        $project: { _id: 0, id: '$_id', docId: 1, text: 1, locator: 1, score: { $meta: 'vectorSearchScore' } }
      }
    ])
    .toArray();
}
