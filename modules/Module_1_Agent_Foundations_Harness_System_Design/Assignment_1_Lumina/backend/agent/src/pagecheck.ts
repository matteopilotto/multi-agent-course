import pino from 'pino';
import { db } from './db.js';
import { env } from './env.js';

const log = pino({ level: env.logLevel });

/**
 * Which pages the quick pre-search must not read as a source, because a reader following the
 * link with a plain request cannot find the quoted text there: Tavily renders the page, a plain
 * GET gets an app shell or a video player. Two rules:
 *   1. A video host is never read: there is no article text a quote could come from.
 *   2. Any other page is checked AFTER the answer, in the background, and the verdict is kept
 *      per URL, so the next answer that meets it skips it. Checking before the answer cost
 *      2.2 s p50 / 5 s p95 before sources (29 questions, 2026-09-30), and the pages it catches
 *      were among the slowest to fetch. The price: a page is read unchecked the first time.
 *   3. A host with HOST_MIN_BAD browser-only pages and no readable one is skipped whole: an app
 *      shell site serves every page the same way, and one forum topic came back as /267, /267/1,
 *      /267/2, /267/4, four URLs a per-URL verdict meets one at a time. Its new URLs are still
 *      checked in the background, so one readable page lifts the rule.
 */
const VIDEO_HOST = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/;

/**
 * Measured 2026-09-30 on 101 pages: the ones whose quote was never found had 6-41 words in their
 * HTML; the shortest page whose quote was found had 167 (agentica.wiki), the next 337. A thin
 * sample around the line (4 pages below it, 1 short real page above it).
 */
const MIN_WORDS = 100;
const HOST_MIN_BAD = 2;
const CHECK_TIMEOUT_MS = 8000;
const VERDICT_TTL_SEC = 7 * 24 * 3600;
const MAX_VERDICTS = 5000;
const USER_AGENT = 'lumina-agent/0.1 (+course project)';

/** words is null when the page was not HTML or not a 2xx: nothing to judge, so it is kept. */
type PageCheckDoc = { _id: string; status: number; words: number | null; checkedAt: Date };

const verdicts = new Map<string, PageCheckDoc>();
/** Per host, how many of its remembered verdicts are browser-only and how many readable. */
const hosts = new Map<string, { bad: number; good: number }>();
const inFlight = new Set<string>();

const collection = async () => (await db()).collection<PageCheckDoc>('pageChecks');

/** The hostname without "www.", so www.site.com and site.com share one tally. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

const browserOnly = (d: PageCheckDoc) => d.words !== null && d.words < MIN_WORDS;

/** Add (+1) or remove (-1) one verdict from its host's tally; a verdict with no word count counts for neither. */
function tally(doc: PageCheckDoc, delta: 1 | -1): void {
  const host = hostOf(doc._id);
  if (!host || doc.words === null) return;
  const t = hosts.get(host) ?? { bad: 0, good: 0 };
  if (browserOnly(doc)) t.bad += delta;
  else t.good += delta;
  if (t.bad === 0 && t.good === 0) hosts.delete(host);
  else hosts.set(host, t);
}

function forget(url: string): void {
  const old = verdicts.get(url);
  if (!old) return;
  verdicts.delete(url);
  tally(old, -1);
}

function remember(doc: PageCheckDoc): void {
  forget(doc._id); // a re-check replaces the old verdict, in the tally too
  verdicts.set(doc._id, doc);
  tally(doc, 1);
  if (verdicts.size > MAX_VERDICTS) {
    const oldest = verdicts.keys().next().value; // insertion order: first key is the oldest
    if (oldest !== undefined) forget(oldest);
  }
}

/** Words a plain reader of the HTML sees: scripts, styles, tags and entities dropped. */
function visibleWords(html: string): number {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

/** Why a page must not be read as a source, or undefined to read it. Memory only: no I/O on the answer's path. */
export function skipAsPage(url: string): string | undefined {
  const host = hostOf(url);
  if (host && VIDEO_HOST.test(host)) return 'video page';
  const v = verdicts.get(url);
  if (v && browserOnly(v)) return `browser-only page, ${v.words} words in its HTML`;
  const t = host ? hosts.get(host) : undefined;
  if (t && t.bad >= HOST_MIN_BAD && t.good === 0) return `browser-only site, ${t.bad} of its pages checked`;
  return undefined;
}

async function check(url: string): Promise<void> {
  let doc: PageCheckDoc;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    const html = res.ok && (res.headers.get('content-type') ?? '').includes('text/html');
    doc = { _id: url, status: res.status, words: html ? visibleWords(await res.text()) : null, checkedAt: new Date() };
    if (!html) await res.body?.cancel();
  } catch (err) {
    // Timeout or no reply: no verdict, so the next sighting tries again.
    log.debug({ err, url }, 'page check got no reply');
    return;
  }
  remember(doc);
  if (doc.words !== null && doc.words < MIN_WORDS) log.info({ url, words: doc.words }, 'page check: browser-only, skipped from now on');
  await (await collection()).replaceOne({ _id: url }, doc, { upsert: true });
}

/** Queue a background check for each URL with no verdict. Never throws, never awaited by an answer. */
export function checkLater(urls: string[]): void {
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || VIDEO_HOST.test(host) || verdicts.has(url) || inFlight.has(url)) continue;
    inFlight.add(url);
    check(url)
      .catch((err: unknown) => log.error({ err, url }, 'page check write failed'))
      .finally(() => inFlight.delete(url));
  }
}

/**
 * Load the verdicts at boot, so a restart does not read a known browser-only page again.
 * Also makes the TTL index: the agent owns this collection, scripts/ does not know it.
 */
export async function loadPageChecks(): Promise<number> {
  const c = await collection();
  await c.createIndex({ checkedAt: 1 }, { expireAfterSeconds: VERDICT_TTL_SEC });
  const since = new Date(Date.now() - VERDICT_TTL_SEC * 1000);
  const rows = await c.find({ checkedAt: { $gt: since } }).sort({ checkedAt: -1 }).limit(MAX_VERDICTS).toArray();
  for (const row of rows.reverse()) remember(row); // newest last, so it is the last evicted
  return rows.length;
}
