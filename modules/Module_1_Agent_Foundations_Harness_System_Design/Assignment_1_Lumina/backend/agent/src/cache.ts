import { createHash } from 'node:crypto';
import type { SearchResult } from './tools.js';
import { COLLECTIONS, SearchCacheDoc } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';
import { webSearch } from './tools.js';

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

type Provider = 'tavily' | 'serpapi';

const collection = async () => (await db()).collection<SearchCacheDoc>(COLLECTIONS.searchCache);

/** Tier 2 read. Checks expiresAt in code: the sweeper runs about once a minute, so the row may still be there. */
export async function readMongo(key: string): Promise<CacheEntry | undefined> {
  const row = await (await collection()).findOne({ _id: key });
  if (!row) return undefined;
  const expiresAt = new Date(row.expiresAt).getTime();
  if (expiresAt <= Date.now()) return undefined;
  return { results: row.results as SearchResult[], expiresAt };
}

/** Tier 2 write. expiresAt MUST be a Date object or the TTL index ignores it. */
export async function writeMongo(
  key: string,
  query: string,
  provider: Provider,
  results: SearchResult[]
): Promise<CacheEntry> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.searchCacheTtlSeconds * 1000);
  const doc: SearchCacheDoc = { _id: key, provider, query, results, expiresAt, createdAt: now };
  SearchCacheDoc.parse(doc); // drift fails here, not in the grader
  await (await collection()).replaceOne({ _id: key }, doc, { upsert: true });
  return { results, expiresAt: expiresAt.getTime() };
}

const lru = new SearchLru();

const THIS_YEAR = new Date().getFullYear();

/** "today", "latest", or a year at or after this one: a six-hour-old result is the wrong answer. */
export function isTimeSensitive(query: string): boolean {
  const q = normalizeQuery(query);
  if (/\b(today|latest|now|yesterday|this (week|month|year))\b/.test(q)) return true;
  const years = q.match(/\b(19|20)\d{2}\b/g) ?? []; // like re.findall
  return years.some((y) => Number(y) >= THIS_YEAR);
}

export type CachedSearch = { results: SearchResult[]; cached: boolean; note?: string };

/** LRU, then Mongo, then the provider. Fills the tiers above whichever one answered. */
export async function cachedWebSearch(query: string): Promise<CachedSearch> {
  if (isTimeSensitive(query)) {
    const results = await webSearch(query); // no read, no write: the row would never be served anyway
    return { results, cached: false, note: 'time-sensitive query, cache bypassed' };
  }
  const provider = env.searchProvider;
  const key = cacheKey(query, provider);

  const hot = lru.get(key);
  if (hot) return { results: hot.results, cached: true, note: 'search cache hit' };

  const warm = await readMongo(key);
  if (warm) {
    lru.set(key, warm);
    return { results: warm.results, cached: true, note: 'search cache hit' };
  }

  const results = await webSearch(query); // throws ProviderError on a provider failure; nothing here catches it
  const entry = await writeMongo(key, query, provider, results);
  lru.set(key, entry);
  return { results, cached: false };
}
