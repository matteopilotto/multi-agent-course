import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import type { RunLog, Source, Terminated, ThreadMessage, TraceEvent } from '@lumina/contract';
import { env, secrets } from './env.js';
import { TOOL_SCHEMAS, fetchPage } from './tools.js';
import { ProviderError } from './errors.js';
import { cachedWebSearch } from './cache.js';
import { send } from './sse.js';
import pino from 'pino';
import { recallMemory, saveMemory, type Recalled } from './memory.js';
import type { ModelUsage } from './cost.js';

const log = pino({ level: env.logLevel });

const client = new Anthropic({ apiKey: secrets.anthropic });

const RESEARCH_SYSTEM = `You are the research phase of LUMINA, a web search assistant.
Your only job is to gather sources. Do not write an answer.

Search results for the question may already be in the first message. If they are not, start with web_search.
1. Call fetch_page on the 2 to 4 most relevant results. Only fetched pages can be cited later.
2. Call web_search again only if those results clearly do not cover the question.
3. When you have read enough, reply with the single word READY.
4. If the user states a durable fact or preference about themselves, call save_memory with it once. If the user's message is only such a statement, save it and reply READY.`;

const ANSWER_SYSTEM = `You are LUMINA, a web search assistant that answers with citations.
Write a concise answer (3 to 6 sentences) using ONLY the numbered sources below.
Cite with [n] right after each claim, where n is a listed source number. Never cite a number that is not listed.
Earlier turns of the conversation may precede the question. Use them to understand what the question refers to, but the citation numbers in earlier answers point at sources that are no longer listed: never reuse them.
If the sources do not cover the question, say so plainly and cite nothing.
If you know things about the user, let their preferences shape the answer (for example, code first when they prefer code). If the user only told you something about themselves rather than asking, confirm in one sentence what you will remember and cite nothing.`;

const CAP_NOTE =
  'Tool budget exhausted. Answer now with what you have, and say plainly what you could not verify.';

type Page = { url: string; title: string; text: string };

/** Earlier turns, bounded: a long thread must not eat the token budget. */
const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_CHARS = 1500;

/** Injected memory is capped, so a chatty user cannot crowd out the sources. */
const MEMORY_MAX_ROWS = 10;
const MEMORY_MAX_CHARS = 4000;

function memoryBlock(recalled: Recalled[]): string {
  if (!recalled.length) return '';
  const lines: string[] = [];
  let chars = 0;
  for (const m of recalled) {
    if (chars + m.text.length > MEMORY_MAX_CHARS) break;
    lines.push(`- ${m.text}`);
    chars += m.text.length;
  }
  return `WHAT YOU KNOW ABOUT THIS USER (long-term memory):\n${lines.join('\n')}`;
}

/** The thread as real model turns, for the answer phase. */
function historyMessages(history: ThreadMessage[]): Anthropic.MessageParam[] {
  const recent = history.slice(-HISTORY_MAX_TURNS);
  while (recent[0]?.role === 'assistant') recent.shift(); // the API wants the first turn to be the user's
  return recent.map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_MAX_CHARS) }));
}

/** The thread as a short text block, for the research phase, which only needs to know what "it" means. */
function historyText(history: ThreadMessage[]): string {
  return history
    .slice(-HISTORY_MAX_TURNS)
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join('\n');
}

/** Owned by the route, filled by the loop, so it survives a throw. */
export type RunState = {
  toolCalls: RunLog['toolCalls'];
  /** The run total, for done.tokens and the run log. */
  tokens: { in: number; out: number };
  /** The same tokens split by model, because the two phases run on models with different prices. */
  usage: ModelUsage;
  /** One entry per successful web_search: true when a cache tier answered. Failures never push. */
  searchHits: boolean[];
};
export const newRunState = (): RunState => ({
  toolCalls: [],
  tokens: { in: 0, out: 0 },
  usage: {},
  searchHits: []
});

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

export type RunContext = { userId: string; threadId: string };

export async function runQuickLoop(
  query: string,
  res: Response,
  startedAt: number,
  state: RunState,
  ctx: RunContext,
  history: ThreadMessage[] = []
): Promise<LoopResult> {
  const { toolCalls, tokens, usage, searchHits } = state;
  /** Every model call passes through here, so the total and the per-model split can never drift apart. */
  const addUsage = (model: string, u: Anthropic.Usage) => {
    tokens.in += u.input_tokens;
    tokens.out += u.output_tokens;
    const bucket = usage[model] ?? { in: 0, out: 0 };
    bucket.in += u.input_tokens;
    bucket.out += u.output_tokens;
    usage[model] = bucket;
  };
  let firstTokenAt = 0;
  const pages: Page[] = [];
  const titles = new Map<string, string>();
  const recalled: Recalled[] = [];
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

      case 'recall_memory': {
        const hits = await recallMemory(ctx.userId, String(input.query), MEMORY_MAX_ROWS);
        recalled.push(...hits);
        const output = hits.length
          ? hits.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
          : '(no memories yet)';
        return { output, note: `${hits.length} recalled` };
      }

      case 'save_memory': {
        const id = await saveMemory(ctx.userId, String(input.text).trim(), ctx.threadId);
        return { output: `saved ${id}` };
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
    const thisStep = step; // captured now: parallel fetches would otherwise all report the last number
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
      step: thisStep,
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

  // ---- phase 0: recall always runs here, as a harness step, because a model that forgets to
  // recall is a memory feature that silently does not exist. On a fresh question it runs in
  // parallel with the pre-search (see below); on a follow-up it runs alone, and the model makes
  // the first search with the thread in view.
  const recall = callTool('recall_memory', { query }, 'harness: what is known about this user');
  let opening: string;
  if (history.length) {
    await recall;
    opening = `Earlier in this conversation:\n${historyText(history)}\n\nQuestion: ${query}\n\nThis is a follow-up. Search for it with the full topic spelled out.`;
  } else {
    const [first] = await Promise.all([
      callTool('web_search', { query }, 'harness pre-search: the question as typed'),
      recall
    ]);
    opening = `Question: ${query}\n\nSearch results for the question as typed:\n${first.output}`;
  }
  const known = memoryBlock(recalled);
  if (known) opening = `${known}\n\n${opening}`;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }];

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
    log.debug(
      { phase: 'research', ms: Date.now() - t0, inTokens: response.usage.input_tokens },
      'model call'
    );

    addUsage(env.llmModelResearch, response.usage);
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;

    const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    // A3: the model may ask for ten fetches in one turn. The harness runs at most
    // env.maxSameToolInARow blocks of any one tool and refuses the rest, so a burst cannot
    // outrun expectations.json's maxConsecutiveSameTool. The refusal is a tool_result with
    // is_error, not silence: the model has to see why it got nothing back, and the API
    // rejects the next turn unless every tool_use block is answered.
    const seen = new Map<string, number>();
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolBlocks.map(async (block) => {
        const nth = (seen.get(block.name) ?? 0) + 1;
        seen.set(block.name, nth);
        if (nth > env.maxSameToolInARow) {
          // Never reaches callTool, so it is never traced, never counted, never billed.
          // It still gets logged: a gate that fires silently is a gate you cannot debug.
          log.warn(
            {
              tool: block.name,
              asked: toolBlocks.filter((b) => b.name === block.name).length,
              ran: env.maxSameToolInARow
            },
            'tool blocks refused: same tool too many times in one turn'
          );
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: `ERROR: refused. At most ${env.maxSameToolInARow} ${block.name} calls per turn. Work with the results you already have, or ask for fewer.`,
            is_error: true
          };
        }

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
    system: [ANSWER_SYSTEM, terminated === 'cap' ? CAP_NOTE : '', known, `SOURCES:\n${sourceBlock}`]
      .filter(Boolean)
      .join('\n\n'),
    messages: [...historyMessages(history), { role: 'user', content: query }]
  });
  stream.on('text', (delta) => {
    if (!firstTokenAt) {
      firstTokenAt = Date.now();
      log.debug({ phase: 'answer', msToFirstDelta: firstTokenAt - t1 }, 'model call');
    }
    send(res, 'token', { text: delta });
  });
  const final = await stream.finalMessage();
  addUsage(env.llmModel, final.usage);
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const searchCalls = providerSearchCalls(state);
  const searchCached = searchHits.length > 0 && searchHits.every(Boolean); // every search was a hit, and there was at least one
  const ttftMs = (firstTokenAt || Date.now()) - startedAt;
  return { text, terminated, sources, searchCalls, searchCached, ttftMs };
}
