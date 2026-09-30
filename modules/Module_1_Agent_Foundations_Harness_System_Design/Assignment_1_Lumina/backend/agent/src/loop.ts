import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import type {
  AskMode,
  Depth,
  PlanEvent,
  RunLog,
  Source,
  Terminated,
  ThreadMessage,
  TraceEvent
} from '@lumina/contract';
import { env, secrets } from './env.js';
import { TOOL_SCHEMAS, fetchPage } from './tools.js';
import { ProviderError } from './errors.js';
import { cachedWebSearch } from './cache.js';
import { send } from './sse.js';
import pino from 'pino';
import { recallMemory, saveMemory, type Recalled } from './memory.js';
import type { ModelUsage } from './cost.js';
import { hybridSearchChunks, rrf, type ChunkHit } from './retrieval.js';
import { documentTitles } from './documents.js';
import { planResearch } from './planner.js';

const log = pino({ level: env.logLevel });

const client = new Anthropic({ apiKey: secrets.anthropic });

const RESEARCH_SYSTEM = `You are the research phase of LUMINA, a search assistant.
Your only job is to gather sources. Do not write an answer.

Results for the question may already be in the first message. Which tools you have depends on where this question should be answered from: use what you were given and never assume a tool you cannot see.
1. With web tools: call fetch_page on the 2 to 4 most relevant results. Only fetched pages can be cited later.
2. With search_documents: the passages it returns are already citable and there is nothing to fetch. Call it again, worded differently, only if the passages clearly miss the question.
3. Call web_search again only if the results clearly do not cover the question.
4. When you have read enough, reply with the single word READY.
5. If the user states a durable fact or preference about themselves, call save_memory with it once. If the user's message is only such a statement, save it and reply READY.`;

const MEMORY_SYSTEM = `You are the memory step of LUMINA, a search assistant. You never answer the message.
If the user's message states a durable fact or preference about themselves (how they want answers, what they build with, their role), call save_memory with it once. A question, however specific, states nothing to remember. Anything listed under what you know about the user is already saved.
Otherwise reply with the single word NONE.`;

const ANSWER_SYSTEM = `You are LUMINA, a search assistant that answers with citations.
Write a concise answer (3 to 6 sentences) using ONLY the numbered sources below.
The sources may be web pages, excerpts from the user's own documents, or both. A document excerpt is cited exactly like a web page: [n].
Cite with [n] right after each claim, where n is a listed source number. Never cite a number that is not listed.
Earlier turns of the conversation may precede the question. Use them to understand what the question refers to, but the citation numbers in earlier answers point at sources that are no longer listed: never reuse them.
If the sources do not cover the question, say so plainly and cite nothing.
If you know things about the user, let their preferences shape the answer (for example, code first when they prefer code). If the user only told you something about themselves rather than asking, confirm in one sentence what you will remember and cite nothing.`;

/**
 * Deep only. The provided UI renders the answer as plain text (pre-wrap; only [n] becomes a chip),
 * so the structure is blank lines and numbered heading lines, never markdown: a "##" would show as "##".
 */
const DEEP_ANSWER_SYSTEM = `You are LUMINA in deep-search mode. The user's question was split into sub-questions, each was researched separately, and the numbered sources below are grouped under the sub-question that found them.
Write a structured answer using ONLY those sources, as plain text (no markdown: no #, no **, no tables), in exactly this shape:

1. The direct answer: 2 to 4 sentences that answer the user's question as asked. If it asks for a decision, give one and say what it hinges on.
2. One section per sub-question, in the listed order. Each starts on its own line with the sub-question's number, a middle dot, and a short title of a few words (for example "2 · Operational burden"), then 2 to 5 sentences. If that sub-question's sources do not answer it, write one sentence saying so instead of filling the section.
3. A last section headed "What is still unknown": 1 to 3 lines starting with "- ", each naming a specific gap in THIS answer: a sub-question the sources left thin, sources that disagree (cite both), or figures that may be out of date. Never generic caveats such as "it depends on your needs" or "consult an expert".

Separate the parts with a blank line.
Cite with [n] right after each claim, where n is a listed source number. A section may cite any listed source, not only those grouped under it. Never cite a number that is not listed, and never state a fact no source supports.
Every sentence must carry a fact, a comparison, or a judgement the sources support. Longer is not better.
Earlier turns of the conversation may precede the question. The citation numbers in earlier answers point at sources that are no longer listed: never reuse them.
If you know things about the user, let their preferences shape the answer.`;

const CAP_NOTE =
  'Tool budget exhausted. Answer now with what you have, and say plainly what you could not verify.';

type Page = { url: string; title: string; text: string };

/** One question's research: its own conversation and what it found. Quick runs one; deep runs one per sub-question. */
type Research = {
  /** The sub-question index this research serves; undefined on a quick run. */
  sq?: number;
  query: string;
  /** Its share of the run's tool calls, and how many it has made. */
  budget: number;
  calls: number;
  /** This question's own tool calls, so the run log can list them together (see the fan-out). */
  log: RunLog['toolCalls'];
  pages: Page[];
  docLists: ChunkHit[][]; // one ranked list per search_documents call, fused at source-build time
  seenChunks: Set<string>;
  docSearches: number;
  staleDocSearch: boolean; // the last search_documents returned only chunks already seen
};
const newResearch = (query: string, budget: number, sq?: number): Research => ({
  sq,
  query,
  budget,
  calls: 0,
  log: [],
  pages: [],
  docLists: [],
  seenChunks: new Set(),
  docSearches: 0,
  staleDocSearch: false
});

/** Earlier turns, bounded: a long thread must not eat the token budget. */
export const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_CHARS = 1500;

/**
 * A quick question that cannot be searched as typed because it leans on the thread: it opens as a
 * continuation, points back at something, leads with a pronoun, or is too short to name a topic.
 * Only strong signals: "What is X and what are its limits?" names its own subject and is not one.
 * A miss costs sources that may not cover the question, which the answer then says plainly; a false
 * hit costs the research turn, i.e. the latency this check exists to save.
 */
export function needsThread(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.split(/\s+/).length <= 3) return true;
  if (/^(and|but|so|also|then|or|what about|how about|why not)\b/.test(q)) return true;
  if (/\b(the|that|this) (first|second|third|last|former|latter|other|same|previous) ?(one|ones)?\b/.test(q)) return true;
  if (/\b(that one|this one|those|these|the above|mentioned|you said)\b/.test(q)) return true;
  if (/\b(that|this)[?.!]*$/.test(q)) return true; // "…to host that?"; a trailing "it" usually points inside the question
  // "What would it cost to…", "is it possible to…": an "it" that points forward, not back.
  if (/\bit (would |will |does |did )?(cost|take|be|mean|make sense|possible|safe|worth|better|necessary)\b/.test(q))
    return false;
  return /^(what|how|why|when|where|who|which|is|are|was|were|does|do|did|can|could|should|would|will)( \w+)? (it|its|they|them|their|this|that)\b/.test(
    q
  );
}

/** The quick pre-search reads up to this many of its results as pages; a page shorter than the floor is a stub. */
const PRESEARCH_PAGES = 4;
const PRESEARCH_PAGE_MIN_CHARS = 500;

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
  /** The plan a deep run researched; undefined on quick. */
  plan?: PlanEvent;
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

/** Two spellings of one page are one source: no fragment, no trailing slash. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url; // not a parseable URL: compare it as written
  }
}

export type RunContext = {
  userId: string;
  threadId: string;
  /** Where to look. The router is this field plus toolsFor below, not a sentence in a prompt. */
  mode: AskMode;
  /** Which gear. Opted into by the caller, never upgraded here: deep plans first, quick never can. */
  depth: Depth;
  spaceId?: string;
};

/**
 * The toolbelt the model actually sees. A mode="web" run cannot call search_documents because
 * the schema is not in the list, and a run with no Space cannot call it because there is
 * nothing to search. A prompt asking the model not to is a suggestion; a missing schema is a
 * gate. Same argument that keeps plan_research away from a quick search (R2).
 */
function toolsFor(ctx: RunContext) {
  const docs = ctx.mode !== 'web' && !!ctx.spaceId;
  const web = ctx.mode !== 'docs';
  return TOOL_SCHEMAS.filter((t) => {
    if (t.name === 'search_documents') return docs;
    if (t.name === 'web_search' || t.name === 'fetch_page') return web;
    return true; // memory is available in every mode
  });
}

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
  const titles = new Map<string, string>(); // shared: a URL has one title whichever search found it
  const recalled: Recalled[] = [];
  const maxCalls = ctx.depth === 'deep' ? env.maxToolCallsDeep : env.maxToolCalls;
  const deadline = Date.now() + (ctx.depth === 'deep' ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000;
  let step = 0;
  let terminated = 'done' as Terminated; // `as`, not `: Terminated =`: researchOne assigns 'cap' from inside a closure, which narrowing cannot see

  /** TOOL_FUNCTIONS from agent_loop.py. Lives inside the loop so it can record what was fetched. */
  async function dispatch(
    name: string,
    input: Record<string, unknown>,
    research?: Research,
    opts?: { withPages?: boolean }
  ): Promise<{ output: string; note?: string }> {
    // Retrieval writes into one question's research; memory serves the whole run.
    const own = () => {
      if (!research) throw new Error(`${name} called outside a research context`);
      return research;
    };
    switch (name) {
      case 'web_search': {
        const { results, cached, note } = await cachedWebSearch(
          String(input.query),
          opts?.withPages ? 'fast-pages' : 'basic'
        );
        searchHits.push(cached);
        for (const r of results) titles.set(r.url, r.title);
        // The quick pre-search came back with the pages themselves: they are read here, in rank
        // order, exactly as fetch_page would have read them. No model turn chooses them.
        const read = new Set<string>();
        if (opts?.withPages) {
          const { pages } = own();
          for (const r of results) {
            if (read.size >= PRESEARCH_PAGES) break;
            if (!r.content || r.content.length < PRESEARCH_PAGE_MIN_CHARS) continue;
            if (pages.some((p) => p.url === r.url)) continue;
            pages.push({ url: r.url, title: r.title, text: r.content.slice(0, 8000) }); // fetchPage's cap
            read.add(r.url);
          }
        }
        const output = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}${read.has(r.url) ? ' (already read)' : ''}\n   ${r.url}\n   ${r.snippet.slice(0, 160)}`
          )
          .join('\n');
        const pagesNote = opts?.withPages ? `${read.size} page(s) read from the results` : undefined;
        // note: "search cache hit", "cache bypassed", or undefined on a plain miss; plus what was read
        return { output, note: [note, pagesNote].filter(Boolean).join('; ') || undefined };
      }

      case 'fetch_page': {
        const { pages } = own();
        const url = String(input.url);
        const text = await fetchPage(url);
        if (!pages.some((p) => p.url === url)) {
          pages.push({ url, title: titles.get(url) ?? new URL(url).hostname, text });
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

      case 'search_documents': {
        // Unreachable unless toolsFor let it through; a throw here is an honest ok:false, not silence.
        if (!ctx.spaceId) throw new Error('search_documents needs a spaceId on the request');
        const r = own();
        const hits = await hybridSearchChunks(ctx.spaceId, ctx.userId, String(input.query));
        r.docLists.push(hits);
        r.docSearches++;
        r.staleDocSearch = hits.length > 0 && hits.every((h) => r.seenChunks.has(h.id));
        hits.forEach((h) => r.seenChunks.add(h.id));
        // Filenames, not docIds: a doc_… id looks like something fetch_page can open, and the model tried.
        const names = await documentTitles([...new Set(hits.map((h) => h.docId))]);
        const output = hits.length
          ? hits
              .map((h, i) => {
                const where = h.locator.page
                  ? `, p. ${h.locator.page}`
                  : h.locator.heading
                    ? `, ${h.locator.heading}`
                    : '';
                return `${i + 1}. [${names.get(h.docId) ?? 'document'}${where}] ${h.text.slice(0, 300)}`;
              })
              .join('\n')
          : '(no matching passages in this Space)';
        return { output, note: `${hits.length} passages, hybrid${r.staleDocSearch ? ', nothing new' : ''}` };
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
    reason?: string,
    research?: Research,
    opts?: { withPages?: boolean }
  ): Promise<{ output: string; error?: string }> {
    if (research) research.calls += 1; // same synchronous moment as step, so a parallel burst counts in order
    step += 1;
    const thisStep = step; // captured now: parallel fetches would otherwise all report the last number
    const t0 = Date.now();
    let output: string;
    let error: string | undefined;
    let fatal: ProviderError | undefined;
    let note: string | undefined;
    try {
      const r = await dispatch(name, input, research, opts);
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
      ...(research?.sq ? { subQuestion: research.sq } : {}),
      ...(why ? { reason: why } : {}),
      ...(error ? { error } : {})
    });
    const entry = { name, ok: !error, ms, ...(error ? { error } : {}) };
    toolCalls.push(entry); // completion order, and pushed at once: a throw later still leaves it in the log
    research?.log.push(entry); // the same object, so the fan-out can regroup it by sub-question
    if (fatal) throw fatal;
    return { output, error };
  }

  // ---- deep only: the plan, before any retrieval. A harness step because it may not be skipped
  // and may not come second. Nothing runs in parallel with it, or its trace could beat `plan`
  // onto the wire. A failed plan ends the run: the server never quietly downgrades deep to quick.
  let plan: PlanEvent | undefined;
  if (ctx.depth === 'deep') {
    step += 1;
    const t0 = Date.now();
    try {
      const r = await planResearch(query, history.length ? historyText(history) : '');
      addUsage(r.model, r.usage);
      plan = r.plan;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const ms = Date.now() - t0;
      send(res, 'trace', { step, tool: 'plan_research', input: { query }, ok: false, ms, error });
      toolCalls.push({ name: 'plan_research', ok: false, ms, error });
      throw e;
    }
    const ms = Date.now() - t0;
    send(res, 'plan', plan);
    send(res, 'trace', {
      step,
      tool: 'plan_research',
      input: { query },
      ok: true,
      ms,
      reason: `harness: deep search, ${plan.subQuestions.length} sub-questions`
    });
    toolCalls.push({ name: 'plan_research', ok: true, ms });
  }

  // ---- phase 0: recall once, as a harness step: memory is about the user, not about any one
  // part of the question. Every research awaits the same promise.
  const recall = callTool('recall_memory', { query }, 'harness: what is known about this user');

  /**
   * Whether the message states something to remember, decided by a turn whose only tool is
   * save_memory. A standalone quick question usually skips the research turn, which is where
   * save_memory used to be offered, so "remember that I…" was answered and never saved. It runs
   * beside the pre-search and ends before `sources`: the stream has no place for a trace after a token.
   */
  async function rememberIfStated(message: string): Promise<void> {
    await recall; // what is already known, so the same preference is not saved twice
    const t0 = Date.now();
    const response = await client.messages.create({
      model: env.llmModelResearch,
      max_tokens: 256,
      system: MEMORY_SYSTEM,
      tools: TOOL_SCHEMAS.filter((t) => t.name === 'save_memory'),
      messages: [
        { role: 'user', content: [memoryBlock(recalled), `Message: ${message}`].filter(Boolean).join('\n\n') }
      ]
    });
    log.debug({ phase: 'memory', ms: Date.now() - t0, inTokens: response.usage.input_tokens }, 'model call');
    addUsage(env.llmModelResearch, response.usage);
    const save = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (save) {
      await callTool(
        'save_memory',
        save.input as Record<string, unknown>,
        'harness: the message states something about the user'
      );
    }
  }

  const useWeb = ctx.mode !== 'docs';
  const useDocs = ctx.mode !== 'web' && !!ctx.spaceId;
  /** Set when any research throws: the other lanes finish their current turn and start nothing new. */
  let stopped = false;

  /** Pre-search and research turns for one question: the question itself on quick, one sub-question on deep. */
  async function researchOne(r: Research): Promise<void> {
    if (step >= maxCalls || Date.now() > deadline) {
      terminated = 'cap';
      return;
    }
    // A planned sub-question is already spelled out; only a quick question in a thread may lean on it.
    const inThread = r.sq === undefined && history.length > 0;
    const followUp = inThread && needsThread(r.query);
    const tag = r.sq ? `harness: sub-question ${r.sq}` : `router: mode=${ctx.mode}`;
    // The question as typed is searched first even in a thread: it is the only search string that is
    // the same every time the question is asked, so it is the one the cache can serve. Skipping it
    // whenever the thread had history made every repeat depend on the model rewording its search the
    // same way twice (12.5% hits on the first full bench). The thread still reaches the model, so a
    // real follow-up ("and its price?") searches again with the topic spelled out.
    // A quick question that stands on its own gets its pages from this search, so no model turn is
    // spent choosing what to fetch (that turn and the fetches were ~2.7 s of a 6.6 s median TTFT).
    // A follow-up's as-typed results are likely off-topic, so it gets results only, as before.
    const withPages = r.sq === undefined && !followUp;
    // The same questions may skip research, so their memory turn runs whether or not research follows,
    // and it alone saves: two turns deciding would save one statement twice. A follow-up keeps
    // save_memory in its research turn, which sees the thread ("yes, remember that").
    const remembers = withPages;
    const [web, docs] = await Promise.all([
      useWeb
        ? callTool('web_search', { query: r.query }, `${tag}, the question as typed`, r, { withPages })
        : undefined,
      useDocs
        ? callTool('search_documents', { query: r.query }, `${tag}, space ${ctx.spaceId}`, r)
        : undefined,
      recall,
      remembers ? rememberIfStated(r.query) : undefined
    ]);
    let opening = [
      inThread ? `Earlier in this conversation:\n${historyText(history)}` : '',
      r.sq ? `This is one part of a larger question: ${query}` : '',
      `Question: ${r.query}`,
      web ? `Web results for the question as typed:\n${web.output}` : '',
      docs ? `Passages from the user's own documents:\n${docs.output}` : '',
      inThread
        ? 'If the question only makes sense with the earlier turns and these results miss its topic, search again with the full topic spelled out. Otherwise work with these results.'
        : ''
    ]
      .filter(Boolean)
      .join('\n\n');
    const known = memoryBlock(recalled);
    if (known) opening = `${known}\n\n${opening}`;
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }];
    // A sub-question never saves memory: four of them would save the same fact four times.
    const tools = r.sq || remembers ? toolsFor(ctx).filter((t) => t.name !== 'save_memory') : toolsFor(ctx);

    const docsFull = () => !useWeb && r.docLists.flat().length >= env.ragTopK;
    // The same "enough to answer from" test the research loop ends on, applied before its first turn.
    const skipResearch = !followUp && (r.pages.length >= 2 || docsFull());
    if (skipResearch)
      log.debug({ phase: 'research', sq: r.sq, skipped: true, pages: r.pages.length }, 'pre-search is enough');

    // ---- phase 1: research. Tools on. Nothing streams but the trace.
    while (!skipResearch) {
      if (stopped) break;
      if (step >= maxCalls || Date.now() > deadline) {
        terminated = 'cap';
        break;
      }
      // This question's share is spent. Not a cap: the run has budget left, it is allocated to the others.
      if (r.calls >= r.budget) break;

      const t0 = Date.now();
      const response = await client.messages.create({
        model: env.llmModelResearch,
        max_tokens: 1024,
        system: RESEARCH_SYSTEM,
        tools, // CHANGED: was toolsFor(ctx); a sub-question's toolbelt has no save_memory
        messages
      });
      log.debug(
        { phase: 'research', sq: r.sq, ms: Date.now() - t0, inTokens: response.usage.input_tokens },
        'model call'
      );

      addUsage(env.llmModelResearch, response.usage);
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') break;

      const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      // A3: at most env.maxSameToolInARow blocks of any one tool per turn. And at most what is left of
      // this question's share: one turn asking for four fetches must not overdraw it. Refusals are
      // tool_results with is_error, not silence: the model has to see why it got nothing back, and
      // the API rejects the next turn unless every tool_use block is answered.
      const seen = new Map<string, number>();
      const remaining = r.budget - r.calls;
      let admitted = 0; // counted synchronously in .map order, before any await, exactly like `seen`
      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (block) => {
          const nth = (seen.get(block.name) ?? 0) + 1;
          seen.set(block.name, nth);
          const refusal =
            nth > env.maxSameToolInARow
              ? `At most ${env.maxSameToolInARow} ${block.name} calls per turn. Work with the results you already have, or ask for fewer.`
              : admitted >= remaining
                ? 'The tool budget for this question is spent. Work with the results you already have.'
                : undefined;
          if (refusal) {
            // Never reaches callTool, so it is never traced, never counted, never billed.
            // It still gets logged: a gate that fires silently is a gate you cannot debug.
            log.warn({ tool: block.name, sq: r.sq, refusal }, 'tool block refused');
            return {
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: `ERROR: refused. ${refusal}`,
              is_error: true
            };
          }
          admitted++;
          const { output, error } = await callTool(
            block.name as TraceEvent['tool'],
            block.input as Record<string, unknown>,
            undefined,
            r
          );
          return { type: 'tool_result' as const, tool_use_id: block.id, content: output, is_error: !!error };
        })
      );

      messages.push({ role: 'user', content: results });
      // Enough to answer from: two fetched pages; or, with no web half, a full set of passages; or the
      // document side is exhausted — a search that found nothing new, or the search budget spent.
      const docsDone = r.staleDocSearch || r.docSearches >= env.maxDocSearches; // CHANGED: r.
      if (r.pages.length >= 2 || docsFull() || docsDone) break; // CHANGED: r.pages
    }
  }

  // Split what is left of the run's budget evenly: without a share, sub-question 1 can spend what
  // sub-question 6 needs, and 6 is answered from nothing. Quick is one research holding all of it.
  const subQs = plan?.subQuestions ?? [];
  const share = Math.floor((maxCalls - step) / Math.max(subQs.length, 1));
  const researches = subQs.length
    ? subQs.map((s) => newResearch(s.question, share, s.i))
    : [newResearch(query, share)];

  // Sub-questions are independent, so they run in parallel, at most env.deepConcurrency at a time.
  // Every lane is awaited before the run ends, even after a failure: no research may still be
  // writing to the stream when the route writes `error` and closes it.
  let next = 0;
  const lane = async () => {
    while (!stopped && next < researches.length) {
      const r = researches[next++] as Research; // read and bumped before any await: no two lanes take one
      try {
        await researchOne(r);
      } catch (e) {
        stopped = true;
        throw e;
      }
    }
  };
  const lanes = Array.from({ length: Math.min(env.deepConcurrency, researches.length) }, lane);
  const failed = (await Promise.allSettled(lanes)).find(
    (s): s is PromiseRejectedResult => s.status === 'rejected'
  );
  if (failed) throw failed.reason;

  // The run log lists each sub-question's calls together, in plan order; the trace keeps the real
  // interleaving (step numbers, ms). Interleaved, three sub-questions fetching at once read as eight
  // fetch_page in a row, and A3, a thrash guard for ONE line of reasoning, would fail a run that
  // never thrashed. Harness steps (plan_research, recall_memory) stay first.
  const fanned = new Set(researches.flatMap((r) => r.log));
  const harnessCalls = toolCalls.filter((t) => !fanned.has(t));
  toolCalls.splice(0, toolCalls.length, ...harnessCalls, ...researches.flatMap((r) => r.log));

  const known = memoryBlock(recalled);

  // ---- the merge: one citation numbering across every research. Walk the researches in plan
  // order; the first to find a source owns it (the planner puts the most important sub-question
  // first) and later finds of it are dropped. n is assigned as a source is accepted, so the
  // numbering is contiguous from 1 by construction.
  // Documents are fused PER research: one rrf over every sub-question's lists would cap a whole deep
  // run at ragTopK passages and forget which sub-question found each one.
  const fused = researches.map((r) => ({ r, docHits: rrf(r.docLists, env.ragTopK, env.rrfK) }));
  const docTitles = await documentTitles([...new Set(fused.flatMap((f) => f.docHits.map((h) => h.docId)))]);
  /** A source, and the text the answer model reads under its number. */
  const merged: { source: Source; body: string }[] = [];
  const taken = new Set<string>();
  for (const { r, docHits } of fused) {
    const tag = r.sq ? { subQuestion: r.sq } : {};
    for (const p of r.pages) {
      const key = `web:${urlKey(p.url)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      merged.push({
        source: {
          n: merged.length + 1,
          kind: 'web',
          title: p.title,
          url: p.url,
          snippet: pickSnippet(p.text, r.query), // against the sub-question, not the whole question
          ...tag
        },
        body: `${p.title} — ${p.url}\n${p.text.slice(0, 4000)}`
      });
    }
    for (const h of docHits) {
      // The chunk, not docId + locator: a long page is several chunks, and merging two of them
      // under one number would leave a snippet that matches neither verbatim.
      const key = `chunk:${h.id}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const title = docTitles.get(h.docId) ?? h.docId;
      const where = h.locator.page
        ? `, p. ${h.locator.page}`
        : h.locator.heading
          ? `, ${h.locator.heading}`
          : '';
      merged.push({
        source: {
          n: merged.length + 1,
          kind: 'doc',
          title,
          docId: h.docId,
          locator: h.locator,
          // The whole chunk, verbatim: for a document source the snippet IS the retrieved unit,
          // and it is what both the grounding check and recall@5 read. A 300-char slice can cut
          // the sentence the gold set is looking for.
          snippet: h.text,
          ...tag
        },
        body: `${title}${where}\n${h.text.slice(0, 4000)}`
      });
    }
  }

  // ---- between the phases: the sources exist now, and the contract wants them before any token.
  const sources = merged.map((m) => m.source);
  send(res, 'sources', sources);

  // ---- phase 2: the answer. No tools at all, only what was retrieved, streamed as it is written.
  // Built from the same list as `sources`, so [n] here is n in the sources event by construction.
  const blocks = merged.map((m) => `[${m.source.n}] ${m.body}`);
  // Deep: the same blocks, grouped under the sub-question that found them, so each section of the
  // answer knows its own evidence. The numbering is untouched: grouping only reorders the prompt,
  // and merged is already in plan order.
  const sourceBlock = !blocks.length
    ? '(no sources were retrieved)'
    : plan
      ? plan.subQuestions
          .map((s) => {
            const own = merged
              .filter((m) => m.source.subQuestion === s.i)
              .map((m) => `[${m.source.n}] ${m.body}`);
            return `=== Sub-question ${s.i}: ${s.question}\n${own.length ? own.join('\n\n') : '(nothing new was found for this sub-question)'}`;
          })
          .join('\n\n')
      : blocks.join('\n\n');

  const maxTokens = plan ? env.deepAnswerMaxTokens : 1024;
  const t1 = Date.now();
  const stream = client.messages.stream({
    model: env.llmModel,
    max_tokens: maxTokens,
    // Sonnet 5 thinks by default on a hard prompt: those tokens count toward max_tokens and never stream
    // as text. Measured: ~1,100 of them cut a 1,385-token deep answer at 2,500, and they sit in front of
    // the first token. The harness already planned; this call only writes from sources it was given.
    thinking: { type: 'disabled' },
    system: [
      plan ? DEEP_ANSWER_SYSTEM : ANSWER_SYSTEM,
      terminated === 'cap' ? CAP_NOTE : '',
      known,
      `SOURCES:\n${sourceBlock}`
    ]
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
  // Not a cap (the research finished), but an answer cut mid-sentence must not pass silently either.
  if (final.stop_reason === 'max_tokens') {
    log.warn(
      { depth: ctx.depth, maxTokens, outTokens: final.usage.output_tokens },
      'answer cut off at max_tokens'
    );
  }
  const text = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const searchCalls = providerSearchCalls(state);
  const searchCached = searchHits.length > 0 && searchHits.every(Boolean); // every search was a hit, and there was at least one
  const ttftMs = (firstTokenAt || Date.now()) - startedAt;
  return { text, terminated, sources, searchCalls, searchCached, ttftMs, plan };
}
