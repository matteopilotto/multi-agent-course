import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Same rates the bench uses, read from the same file, so /done and the grader never disagree. */
const sla = JSON.parse(readFileSync(resolve(process.cwd(), '../../benchmark/sla.json'), 'utf8'));
type Rates = { input_usd_per_mtok: number; output_usd_per_mtok: number };
const prices = sla.cost_model as Rates & { search_usd_per_call: number; models?: Record<string, Rates> };

/** An unlisted model is billed at the file's top-level rate, which is the most expensive one. */
const ratesFor = (model: string): Rates => prices.models?.[model] ?? prices;

/** Tokens spent, per model. The loop runs two: a cheap research model and the answer model. */
export type ModelUsage = Record<string, { in: number; out: number }>;

/**
 * One run's bill. Every model is priced at its own rate: charging Haiku research tokens at the
 * Sonnet rate overstated a quick answer by roughly a third, which is not a safe error when a
 * $0.05 gate reads this number.
 */
export function costUsd(usage: ModelUsage, searchCalls: number): number {
  let usd = searchCalls * prices.search_usd_per_call;
  for (const [model, t] of Object.entries(usage)) {
    const r = ratesFor(model);
    usd += (t.in * r.input_usd_per_mtok + t.out * r.output_usd_per_mtok) / 1_000_000;
  }
  return Math.round(usd * 1e6) / 1e6;
}
