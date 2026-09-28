import { env } from './env.js';
import { deepCountToday, nextUtcDay } from './stats.js';

/**
 * Deep searches started but not yet written to `requests`. The requests row lands when a run
 * ends, so counting rows alone lets a user start six deep searches at once and have all six see
 * zero. One agent process holds this map (DESIGN: one agent machine); a second machine would
 * need the reservation in Mongo instead.
 */
const inFlight = new Map<string, number>();

export type DeepSlot = { release: () => void };

/**
 * The deep-search spend gate: take a slot, or learn when the allowance resets. The place in line
 * is taken synchronously, before the first await, so two requests arriving together cannot both
 * be the last one allowed. When a run ends between another's reservation and its count, that run
 * is counted twice for a moment: the gate errs toward refusing, never toward overspending.
 */
export async function reserveDeep(userId: string): Promise<DeepSlot | { resetsAt: string }> {
  const ahead = inFlight.get(userId) ?? 0;
  inFlight.set(userId, ahead + 1);
  const release = () => {
    const left = (inFlight.get(userId) ?? 1) - 1;
    if (left > 0) inFlight.set(userId, left);
    else inFlight.delete(userId);
  };
  let spent: number;
  try {
    spent = await deepCountToday(userId); // throws when Mongo is down: fail closed, as a 502
  } catch (e) {
    release();
    throw e;
  }
  if (spent + ahead >= env.deepDailyCap) {
    release();
    return { resetsAt: nextUtcDay().toISOString() };
  }
  return { release };
}
