import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from './env.js';
import { ProviderError } from './errors.js';

/** OpenAI wraps its reason in JSON. Pull it out here: the layer that knows the provider's shape owns this. */
async function detail(r: Response): Promise<string> {
  const body = await r.text();
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    return body;
  }
}

/**
 * Texts → 1536-dim vectors, one HTTP call, order preserved. Native fetch on purpose: the
 * openai SDK's bundled node-fetch closes gzip streams early on Node 22 ("Premature close").
 * Throws on a provider failure, a wrong model, or a short reply: never a plausible empty.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secrets.openai}`
    },
    body: JSON.stringify({ model: env.embeddingModel, input: texts })
  });
  if (!r.ok) throw new ProviderError(`openai embeddings ${r.status}: ${await detail(r)}`, r.status);
  const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
  if (data.data.length !== texts.length) {
    throw new ProviderError(`embedding returned ${data.data.length} vectors for ${texts.length} inputs`);
  }
  const out: number[][] = new Array<number[]>(texts.length);
  for (const item of data.data) {
    if (item.embedding.length !== EMBEDDING_DIMS) {
      throw new ProviderError(
        `embedding returned ${item.embedding.length} dims, expected ${EMBEDDING_DIMS} (model ${env.embeddingModel})`
      );
    }
    out[item.index] = item.embedding;
  }
  return out;
}

export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedMany([text]);
  if (!vec) throw new ProviderError('embedding returned nothing');
  return vec;
}
