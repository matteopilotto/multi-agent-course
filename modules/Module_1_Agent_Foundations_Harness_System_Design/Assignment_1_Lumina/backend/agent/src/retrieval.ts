import { COLLECTIONS, SEARCH_INDEXES, type ChunkDoc, type Locator } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { embed } from './embed.js';

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

/**
 * Sparse retrieval over one Space: Atlas Search's BM25 on chunks.text. Both filters live
 * inside $search's compound for the same reason they live inside $vectorSearch — a later
 * $match ranks another Space's chunks first and then hides them. spaceId and userId are
 * mapped as `token`, not `string`, so they are never analysed and `equals` means equals.
 */
export async function textSearchChunks(
  spaceId: string,
  userId: string,
  query: string,
  k: number
): Promise<ChunkHit[]> {
  const col = await chunks();

  if (env.vectorBackend === 'mongo-cosine-scan') {
    // Local mongod has no Atlas Search either. Term overlap, not BM25: no idf, no length
    // normalisation. Enough to keep the fusion path exercised locally, and /health says so.
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const rows = await col.find({ spaceId, userId }).toArray();
    return rows
      .map((c) => ({
        id: c._id,
        docId: c.docId,
        text: c.text,
        locator: c.locator,
        score: terms.filter((t) => c.text.toLowerCase().includes(t)).length
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  return col
    .aggregate<ChunkHit>([
      {
        $search: {
          index: SEARCH_INDEXES.chunksText,
          compound: {
            must: [{ text: { query, path: 'text' } }],
            filter: [
              { equals: { path: 'spaceId', value: spaceId } },
              { equals: { path: 'userId', value: userId } }
            ]
          }
        }
      },
      { $limit: k },
      { $project: { _id: 0, id: '$_id', docId: 1, text: 1, locator: 1, score: { $meta: 'searchScore' } } }
    ])
    .toArray();
}

/**
 * Reciprocal rank fusion. A cosine similarity and a BM25 score are not on the same scale and
 * never will be, so RRF throws both scores away and fuses the RANKS: every list contributes
 * 1/(rrfK + rank) to each chunk it returned. A chunk both branches liked a bit beats a chunk
 * one branch loved, which is exactly the behaviour the two halves exist to produce.
 */
export function rrf(lists: ChunkHit[][], k: number, rrfK: number): ChunkHit[] {
  const fused = new Map<string, { hit: ChunkHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const row = fused.get(hit.id) ?? { hit, score: 0 };
      row.score += 1 / (rrfK + i + 1); // i + 1: rank is 1-based
      fused.set(hit.id, row);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ hit, score }) => ({ ...hit, score })); // the fused score, not either branch's
}

/**
 * The retrieval half of search_documents: both branches in parallel, fused, top-k.
 *
 * No cross-encoder re-rank step (SPEC 5.4 allows the skip if it is documented): it would add
 * a third provider and ~300 ms to every doc question to reorder five passages that the answer
 * model then reads in full anyway. If recall@5 comes in near the floor, this is the first
 * thing to add back.
 *
 * Both branches fail loud. An embeddings outage is a ProviderError and ends the run as a 502,
 * never a doc question that quietly answers from the web instead.
 */
export async function hybridSearchChunks(
  spaceId: string,
  userId: string,
  query: string
): Promise<ChunkHit[]> {
  const [dense, sparse] = await Promise.all([
    embed(query).then((v) => vectorSearchChunks(spaceId, userId, v, env.ragCandidates)),
    textSearchChunks(spaceId, userId, query, env.ragCandidates)
  ]);
  return rrf([dense, sparse], env.ragTopK, env.rrfK);
}
