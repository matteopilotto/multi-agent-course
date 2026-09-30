import pino from 'pino';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from './env.js';
import { ProviderError } from './errors.js';

const log = pino({ level: env.logLevel });

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
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secrets.openai}`
      },
      body: JSON.stringify({ model: env.embeddingModel, input: texts })
    });
  } catch (e) {
    // No reply at all (DNS, reset, refused). A bare TypeError is not a ProviderError, so callTool
    // traced it and carried on: recall answered as if the user had no memories.
    throw new ProviderError(`openai embeddings unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/** One more go for an ask-time embedding: the second bench's only errors were single OpenAI 500s. */
const EMBED_RETRY_DELAY_MS = 300;

/**
 * One text → one vector, for the ask path (recall, save, document search). A retryable failure gets
 * one more try; a second failure still ends the run. The worker calls embedMany and retries whole jobs.
 */
export async function embed(text: string): Promise<number[]> {
  let vec: number[] | undefined;
  try {
    [vec] = await embedMany([text]);
  } catch (e) {
    if (!(e instanceof ProviderError && e.retryable)) throw e;
    log.warn({ err: e.message }, 'embedding failed, retrying once');
    await new Promise((resolve) => setTimeout(resolve, EMBED_RETRY_DELAY_MS));
    [vec] = await embedMany([text]);
  }
  if (!vec) throw new ProviderError('embedding returned nothing');
  return vec;
}
