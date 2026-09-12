import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import type { RunLog, Source, Terminated, TraceEvent } from '@lumina/contract';
import { env, secrets } from './env.js';
import { TOOL_SCHEMAS, fetchPage, ProviderError } from './tools.js';
import { cachedWebSearch } from './cache.js';
import { send } from './sse.js';
import pino from 'pino';
const log = pino({ level: env.logLevel });

const client = new Anthropic({ apiKey: secrets.anthropic });

const RESEARCH_SYSTEM = `You are the research phase of LUMINA, a web search assistant.
Your only job is to gather sources. Do not write an answer.

Search results for the question are already in the first message.
1. Call fetch_page on the 2 to 4 most relevant results. Only fetched pages can be cited later.
2. Call web_search again only if those results clearly do not cover the question.
3. When you have read enough, reply with the single word READY.`;

const ANSWER_SYSTEM = `You are LUMINA, a web search assistant that answers with citations.
Write a concise answer (3 to 6 sentences) using ONLY the numbered sources below.
Cite with [n] right after each claim, where n is a listed source number. Never cite a number that is not listed.
If the sources do not cover the question, say so plainly and cite nothing.`;

const CAP_NOTE =
  'Tool budget exhausted. Answer now with what you have, and say plainly what you could not verify.';

type Page = { url: string; title: string; text: string };

/** Owned by the route, filled by the loop, so it survives a throw. */
export type RunState = {
  toolCalls: RunLog['toolCalls'];
  tokens: { in: number; out: number };
  /** One entry per successful web_search: true when a cache tier answered. Failures never push. */
  searchHits: boolean[];
};
export const newRunState = (): RunState => ({ toolCalls: [], tokens: { in: 0, out: 0 }, searchHits: [] });

/** Only misses reached the provider, so only misses are billed. */
export const providerSearchCalls = (s: RunState) => s.searchHits.filter((hit) => !hit).length;

export type LoopResult = {
  text: string;
  terminated: Terminated;
  sources: Source[];
  searchCalls: number;
  ttftMs: number;
  searchCached: boolean;
};

/** The paragraph of a fetched page most related to the query, verbatim, so the grounding check can find it. */
function pickSnippet(text: string, query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3);
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 80);
  let best = paragraphs[0] ?? text.slice(0, 300);
  let bestScore = -1;
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    const score = terms.filter((t) => lower.includes(t)).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best.slice(0, 300);
}

export async function runQuickLoop(
  query: string,
  res: Response,
  startedAt: number,
  state: RunState
): Promise<LoopResult> {
  const { toolCalls, tokens, searchHits } = state;
  const addUsage = (u: Anthropic.Usage) => {
    tokens.in += u.input_tokens;
    tokens.out += u.output_tokens;
  };
  let firstTokenAt = 0;
  const pages: Page[] = [];
  const titles = new Map<string, string>();
  const deadline = Date.now() + env.maxWallClockSec * 1000;
  let step = 0;
  let terminated: Terminated = 'done';

  /** TOOL_FUNCTIONS from agent_loop.py. Lives inside the loop so it can record what was fetched. */
  async function dispatch(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ output: string; note?: string }> {
    switch (name) {
      case 'web_search': {
        const { results, cached, note } = await cachedWebSearch(String(input.query));
        searchHits.push(cached);
        for (const r of results) titles.set(r.url, r.title);
        const output = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 160)}`)
          .join('\n');
        return { output, note }; // note: "search cache hit", "cache bypassed", or undefined on a plain miss
      }

      case 'fetch_page': {
        const url = String(input.url);
        const text = await fetchPage(url);
        if (!pages.some((p) => p.url === url)) {
          pages.push({
            url,
            title: titles.get(url) ?? new URL(url).hostname,
            text
          });
        }
        return { output: text };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  /** One tool call, traced and recorded. A provider failure is traced first, then ends the run. */
  async function callTool(
    name: TraceEvent['tool'],
    input: Record<string, unknown>,
    reason?: string
  ): Promise<{ output: string; error?: string }> {
    step += 1;
    const t0 = Date.now();
    let output: string;
    let error: string | undefined;
    let fatal: ProviderError | undefined;
    let note: string | undefined;
    try {
      const r = await dispatch(name, input);
      output = r.output;
      note = r.note;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      output = `ERROR: ${error}`;
      if (e instanceof ProviderError) fatal = e;
    }
    const ms = Date.now() - t0;
    const why = [reason, note].filter(Boolean).join('; ');
    send(res, 'trace', {
      step,
      tool: name,
      input,
      ok: !error,
      ms,
      ...(why ? { reason: why } : {}),
      ...(error ? { error } : {})
    });
    toolCalls.push({ name, ok: !error, ms, ...(error ? { error } : {}) });
    if (fatal) throw fatal;
    return { output, error };
  }

  // ---- phase 0: the harness searches the question as typed. A model turn that rewrites
  // "What is Tavily?" into "What is Tavily" is a hop paid for nothing. The model can still
  // search again if these results do not cover the question.
  const first = await callTool('web_search', { query }, 'harness pre-search: the question as typed');
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Question: ${query}\n\nSearch results for the question as typed:\n${first.output}`
    }
  ];

  // ---- phase 1: research. Tools on. Nothing streams but the trace.
  while (true) {
    if (step >= env.maxToolCalls || Date.now() > deadline) {
      terminated = 'cap';
      break;
    }
    const t0 = Date.now();
    const response = await client.messages.create({
      model: env.llmModelResearch,
      max_tokens: 1024,
      system: RESEARCH_SYSTEM,
      tools: TOOL_SCHEMAS,
      messages
    });
    log.info({ phase: 'research', ms: Date.now() - t0, inTokens: response.usage.input_tokens }, 'model call');

    addUsage(response.usage);
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;

    const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolBlocks.map(async (block) => {
        const { output, error } = await callTool(
          block.name as TraceEvent['tool'],
          block.input as Record<string, unknown>
        );
        return { type: 'tool_result' as const, tool_use_id: block.id, content: output, is_error: !!error };
      })
    );

    messages.push({ role: 'user', content: results });
    if (pages.length >= 2) break; // enough to answer from; do not spend a turn asking the model to say so
  }

  // ---- between the phases: the sources exist now, and the contract wants them before any token.
  const sources: Source[] = pages.map((p, i) => ({
    n: i + 1,
    kind: 'web',
    title: p.title,
    url: p.url,
    snippet: pickSnippet(p.text, query)
  }));
  send(res, 'sources', sources);

  // ---- phase 2: the answer. No tools at all, only the fetched pages, streamed as it is written.
  const sourceBlock = pages.length
    ? pages.map((p, i) => `[${i + 1}] ${p.title} — ${p.url}\n${p.text.slice(0, 4000)}`).join('\n\n')
    : '(no sources were retrieved)';
  const t1 = Date.now();
  const stream = client.messages.stream({
    model: env.llmModel,
    max_tokens: 1024,
    system: `${ANSWER_SYSTEM}\n\n${terminated === 'cap' ? `${CAP_NOTE}\n\n` : ''}SOURCES:\n${sourceBlock}`,
    messages: [{ role: 'user', content: query }]
  });
  stream.on('text', (delta) => {
    if (!firstTokenAt) {
      firstTokenAt = Date.now();
      log.info({ phase: 'answer', msToFirstDelta: firstTokenAt - t1 }, 'model call');
    }
    send(res, 'token', { text: delta });
  });
  const final = await stream.finalMessage();
  addUsage(final.usage);
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const searchCalls = providerSearchCalls(state);
  const searchCached = searchHits.length > 0 && searchHits.every(Boolean); // every search was a hit, and there was at least one
  const ttftMs = (firstTokenAt || Date.now()) - startedAt;
  return { text, terminated, sources, searchCalls, searchCached, ttftMs };
}
