import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from './env.js';
import { ProviderError } from './tools.js';

/**
 * Text → 1536-dim vector, via one HTTP call to OpenAI. Native fetch on purpose: the openai
 * SDK's bundled node-fetch closes gzip streams early on Node 22 ("Premature close").
 * Throws on a provider failure or a wrong model: never returns a plausible empty.
 */
export async function embed(text: string): Promise<number[]> {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secrets.openai}`
    },
    body: JSON.stringify({ model: env.embeddingModel, input: text })
  });
  if (!r.ok) throw new ProviderError(`openai embeddings ${r.status}: ${await r.text()}`);
  const data = (await r.json()) as { data: { embedding: number[] }[] };
  const vec = data.data[0]?.embedding;
  if (!vec || vec.length !== EMBEDDING_DIMS) {
    throw new ProviderError(
      `embedding returned ${vec?.length ?? 0} dims, expected ${EMBEDDING_DIMS} (model ${env.embeddingModel})`
    );
  }
  return vec;
}
