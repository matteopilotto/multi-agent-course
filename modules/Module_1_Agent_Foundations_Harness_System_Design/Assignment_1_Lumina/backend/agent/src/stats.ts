import { COLLECTIONS, type MessageDoc, type RequestDoc, type StatsResponse } from '@lumina/contract';
import { db } from './db.js';
import { env } from './env.js';

/**
 * Midnight UTC that starts the current day. One boundary for the whole service: `costUsdToday`
 * names it, and the deep-search cap has to agree with /stats about which day it is, or a user
 * reads "2 of 5 used" while the gate refuses them.
 */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** When the allowance resets. The deep-search 429 returns this as `resetsAt`. */
export function nextUtcDay(now = new Date()): Date {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Deep searches this user has spent today. Per user, not service-wide: the cap is a per-user
 * allowance, so the number that reports it has to be counted the same way it is enforced.
 */
export async function deepCountToday(userId: string): Promise<number> {
  const requests = (await db()).collection<RequestDoc>(COLLECTIONS.requests);
  return requests.countDocuments({ userId, depth: 'deep', createdAt: { $gte: startOfUtcDay() } });
}

/** The 95th percentile of a list, nearest-rank. Empty list has no percentile, so 0. */
function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[rank] ?? 0;
}

/**
 * Everything /stats reports, over today on the UTC boundary.
 *
 * Two sources, deliberately: spend and request volume come from `requests`, so a run that
 * failed still costs what it cost; latency and cache come from `messages.done`, because an
 * answer that never finished has no ttft to report. Counts are service-wide except
 * `deepToday` — the bench drives several user ids, and a per-user `answers` would sit below
 * the answers its own run produced and fail to reconcile.
 */
export async function getStats(userId: string): Promise<StatsResponse> {
  const database = await db();
  const since = startOfUtcDay();
  const requests = database.collection<RequestDoc>(COLLECTIONS.requests);
  const messages = database.collection<MessageDoc>(COLLECTIONS.messages);

  const [totals, done, deepToday] = await Promise.all([
    requests
      .aggregate<{ requests: number; costUsd: number }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            requests: { $sum: 1 },
            // A row written before costUsd existed, or a 401 that never reached the loop, contributes 0.
            costUsd: { $sum: { $ifNull: ['$costUsd', 0] } }
          }
        }
      ])
      .toArray(),
    messages
      .find(
        { role: 'assistant', done: { $exists: true }, createdAt: { $gte: since } },
        { projection: { 'done.ttftMs': 1, 'done.searchCached': 1 } }
      )
      .toArray(),
    deepCountToday(userId)
  ]);

  const answers = done.length;
  const cached = done.filter((m) => m.done?.searchCached).length;
  const ttfts = done.map((m) => m.done?.ttftMs ?? 0);

  return {
    requests: totals[0]?.requests ?? 0,
    answers,
    searchCacheHitRatePct: answers ? Math.round((cached / answers) * 1000) / 10 : 0,
    ttftP95Ms: Math.round(p95(ttfts)),
    costUsdToday: Math.round((totals[0]?.costUsd ?? 0) * 1e6) / 1e6,
    deepToday,
    deepDailyCap: env.deepDailyCap
  };
}
