import { createHash } from 'node:crypto';
import type { SearchResult } from './tools.js';

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

export type CacheEntry = { results: SearchResult[]; expiresAt: number }; // expiresAt in epoch ms

/**
 * Tier 1. Per process, empty on restart, refilled from Mongo. A Map keeps insertion order,
 * so the first key is the least recently used (same idea as OrderedDict.move_to_end).
 */
export class SearchLru {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly maxEntries = 500) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key); // expired: a miss, even though it is still in memory
      return undefined;
    }
    this.map.delete(key); // bump to most recent
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value; // first key = least recently used
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
