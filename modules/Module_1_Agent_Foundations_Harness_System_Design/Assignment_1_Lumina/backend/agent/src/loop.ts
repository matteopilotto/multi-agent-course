import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import type { RunLog, Source, Terminated, TraceEvent } from '@lumina/contract';
import { env, secrets } from './env.js';
import { TOOL_SCHEMAS, webSearch, fetchPage, ProviderError } from './tools.js';
import { send } from './sse.js';

const client = new Anthropic({ apiKey: secrets.anthropic });

const RESEARCH_SYSTEM = `You are the research phase of LUMINA, a web search assistant.
Your only job is to gather sources. Do not write an answer.

Procedure:
1. Call web_search once or twice with focused queries.
2. Call fetch_page on the 2 to 4 most relevant results. Only fetched pages can be cited later.
3. When you have read enough, reply with the single word READY.`;

const ANSWER_SYSTEM = `You are LUMINA, a web search assistant that answers with citations.
Write a concise answer (3 to 6 sentences) using ONLY the numbered sources below.
Cite with [n] right after each claim, where n is a listed source number. Never cite a number that is not listed.
If the sources do not cover the question, say so plainly and cite nothing.`;

const CAP_NOTE =
  'Tool budget exhausted. Answer now with what you have, and say plainly what you could not verify.';

type Page = { url: string; title: string; text: string };

export type LoopResult = {
  text: string;
  terminated: Terminated;
  toolCalls: RunLog['toolCalls'];
  sources: Source[];
  tokens: { in: number; out: number };
  searchCalls: number;
  ttftMs: number;
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

export async function runQuickLoop(query: string, res: Response, startedAt: number): Promise<LoopResult> {
  const tokens = { in: 0, out: 0 };
  const addUsage = (u: Anthropic.Usage) => {
    tokens.in += u.input_tokens;
    tokens.out += u.output_tokens;
  };
  let firstTokenAt = 0;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];
  const toolCalls: RunLog['toolCalls'] = [];
  const pages: Page[] = [];
  const titles = new Map<string, string>();
  const deadline = Date.now() + env.maxWallClockSec * 1000;
  let step = 0;
  let terminated: Terminated = 'done';

  /** TOOL_FUNCTIONS from agent_loop.py. Lives inside the loop so it can record what was fetched. */
  async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'web_search': {
        const results = await webSearch(String(input.query));
        for (const r of results) titles.set(r.url, r.title);
        return JSON.stringify(results);
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
        return text;
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // ---- phase 1: research. Tools on. Nothing streams but the trace.
  while (true) {
    if (step >= env.maxToolCalls || Date.now() > deadline) {
      terminated = 'cap';
      break;
    }
    const response = await client.messages.create({
      model: env.llmModel,
      max_tokens: 1024,
      system: RESEARCH_SYSTEM,
      tools: TOOL_SCHEMAS,
      messages
    });
    addUsage(response.usage);
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      step += 1;
      const input = block.input as Record<string, unknown>;
      const t0 = Date.now();
      let output: string;
      let error: string | undefined;
      let fatal: ProviderError | undefined;
      try {
        output = await dispatch(block.name, input);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        output = `ERROR: ${error}`;
        if (e instanceof ProviderError) fatal = e;
      }

      const ms = Date.now() - t0;
      const trace: TraceEvent = {
        step,
        tool: block.name as TraceEvent['tool'],
        input,
        ok: !error,
        ms,
        ...(error ? { error } : {})
      };
      send(res, 'trace', trace);
      toolCalls.push({
        name: trace.tool,
        ok: !error,
        ms,
        ...(error ? { error } : {})
      });
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
        is_error: !!error
      });
      if (fatal) throw fatal; // the step is traced as ok:false, THEN the run ends
    }
    messages.push({ role: 'user', content: results });
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
    ? pages.map((p, i) => `[${i + 1}] ${p.title} — ${p.url}\n${p.text.slice(0, 6000)}`).join('\n\n')
    : '(no sources were retrieved)';
  const stream = client.messages.stream({
    model: env.llmModel,
    max_tokens: 1024,
    system: `${ANSWER_SYSTEM}\n\n${terminated === 'cap' ? `${CAP_NOTE}\n\n` : ''}SOURCES:\n${sourceBlock}`,
    messages: [{ role: 'user', content: query }]
  });
  stream.on('text', (delta) => {
    if (!firstTokenAt) firstTokenAt = Date.now();
    send(res, 'token', { text: delta });
  });
  const final = await stream.finalMessage();
  addUsage(final.usage);
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const searchCalls = toolCalls.filter((t) => t.name === 'web_search' && t.ok).length;
  const ttftMs = (firstTokenAt || Date.now()) - startedAt;

  return { text, terminated, toolCalls, sources, tokens, searchCalls, ttftMs };
}
