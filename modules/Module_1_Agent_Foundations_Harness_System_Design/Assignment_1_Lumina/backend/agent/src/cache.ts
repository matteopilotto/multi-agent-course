import { createHash } from 'node:crypto';

/**
 * The query as the cache sees it. Only transformations that cannot change the meaning:
 * trim, lowercase, collapse whitespace, drop trailing ? and . No stemming, no reordering.
 */
export function normalizeQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ') // like re.sub(r"\s+", " ", s)
    .replace(/[?.!]+$/, ''); // strip trailing ? . !
}

/**
 * sha256(normalized query + provider). The provider is in the key so a SEARCH_PROVIDER flip
 * never serves the other provider's rows. Same as hashlib.sha256(s.encode()).hexdigest().
 */
export function cacheKey(query: string, provider: string): string {
  return createHash('sha256')
    .update(`${normalizeQuery(query)}\n${provider}`)
    .digest('hex');
}
