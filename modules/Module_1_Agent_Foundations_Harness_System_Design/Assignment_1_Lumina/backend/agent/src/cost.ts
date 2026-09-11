import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Same rates the bench uses, read from the same file, so /done and the grader never disagree. */
const sla = JSON.parse(readFileSync(resolve(process.cwd(), '../../benchmark/sla.json'), 'utf8'));
const prices = sla.cost_model as {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  search_usd_per_call: number;
};

export function costUsd(tokens: { in: number; out: number }, searchCalls: number): number {
  const usd =
    (tokens.in * prices.input_usd_per_mtok + tokens.out * prices.output_usd_per_mtok) / 1_000_000 +
    searchCalls * prices.search_usd_per_call;
  return Math.round(usd * 1e6) / 1e6;
}
