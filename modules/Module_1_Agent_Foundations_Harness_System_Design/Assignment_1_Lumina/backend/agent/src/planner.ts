import Anthropic from '@anthropic-ai/sdk';
import { PlanEvent, type SubQuestion } from '@lumina/contract';
import { env, secrets } from './env.js';

const client = new Anthropic({ apiKey: secrets.anthropic });

/** Built per call, not at module load: a date baked in at startup goes stale on a long-lived deploy. */
function planSystem(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the planning phase of LUMINA's deep search. You do not search and you do not answer.
  Today is ${today}. Never put a year in a sub-question unless the user's question names one: search engines already favour recent pages, and a guessed year pins the search to the wrong one.
  Break the user's question into ${env.deepSubQuestionsMin} to ${env.deepSubQuestionsMax} sub-questions that together answer it. Aim for 4; use more only when the question really has more parts.
  Each sub-question must:
  - read like a search query a person would type: at most 15 words, topic spelled out (never "it" or "this"),
  - need a different kind of page than the others (vendor docs, pricing, benchmarks, migration write-ups, practitioner opinion): two sub-questions that would find the same pages are one sub-question,
  - not restate the original question.
  Give each a reason of at most 12 words naming the part of the question it serves. Put the most important first.`;
}

/**
 * Not in TOOL_SCHEMAS on purpose: no research turn, quick or deep, ever sees it. The harness
 * calls it once, first, on a deep run. That missing schema is R2's gate.
 */
const PLAN_TOOL = {
  name: 'plan_research',
  description: 'Record the research plan: the sub-questions to investigate, each with a one-line reason.',
  input_schema: {
    type: 'object' as const,
    properties: {
      subQuestions: {
        type: 'array',
        minItems: env.deepSubQuestionsMin,
        maxItems: env.deepSubQuestionsMax,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'A self-contained, search-ready question' },
            reason: { type: 'string', description: 'One line: which part of the question this serves' }
          },
          required: ['question', 'reason']
        }
      },
      reason: { type: 'string', description: 'One sentence: why the question splits this way' }
    },
    required: ['subQuestions', 'reason']
  }
};

export async function planResearch(query: string, context: string) {
  const response = await client.messages.create({
    model: env.llmModelPlanner,
    max_tokens: 1024,
    system: planSystem(),
    tools: [PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'plan_research' }, // forced: the reply IS the plan, as JSON
    messages: [{ role: 'user', content: context ? `${context}\n\nQuestion: ${query}` : `Question: ${query}` }]
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!block) throw new Error('planner returned no plan');
  const raw = block.input as { subQuestions?: { question: string; reason?: string }[]; reason?: string };
  // The schema's minItems/maxItems guide the model; they do not bind it. The harness checks the count,
  // and the harness numbers them, so i is always 1..n with no gaps.
  const subQuestions: SubQuestion[] = (raw.subQuestions ?? [])
    .slice(0, env.deepSubQuestionsMax)
    .map((s, idx) => ({ i: idx + 1, question: s.question, reason: s.reason }));
  if (subQuestions.length < env.deepSubQuestionsMin) {
    throw new Error(`planner returned ${subQuestions.length} sub-questions, need ${env.deepSubQuestionsMin}`);
  }
  return {
    plan: PlanEvent.parse({ subQuestions, reason: raw.reason }),
    usage: response.usage,
    model: env.llmModelPlanner
  };
}
