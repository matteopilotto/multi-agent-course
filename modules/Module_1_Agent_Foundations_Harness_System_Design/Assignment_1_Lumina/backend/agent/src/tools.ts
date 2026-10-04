import { secrets } from './env.js';
import { ProviderError } from './errors.js';

/** content: the page's own text, only when the search was asked for pages. */
export type SearchResult = { title: string; url: string; snippet: string; content?: string };

/**
 * 'basic': Tavily's default depth, results only; the model fetches what it wants to read.
 * 'fast-pages': the quick pre-search. Measured at concurrency 4: 0.6-0.7 s with the pages'
 * text included, against 1.5-2.7 s for 'basic' without it, then a model turn and the fetches.
 */
export type SearchMode = 'basic' | 'fast-pages';

/** Tavily's time_range: only pages published in the last day, week or month. */
export const RECENCIES = ['day', 'week', 'month'] as const;
export type Recency = (typeof RECENCIES)[number];

/** One HTTP call to Tavily. Throws on a non-2xx: fail loud, never return a plausible empty. */
async function tavily<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`https://api.tavily.com/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secrets.tavily}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const msg = `tavily ${path} ${r.status}: ${await r.text()}`;
    // The provider refusing us is fatal wherever it happens: a bad key, no quota, or an outage
    // is not "this page could not be read". Search has no per-page notion, so any failure there
    // is fatal too. Everything else is one page failing, which the model should see and route around.
    const refused = r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500;
    if (refused || path === 'search') throw new ProviderError(msg, r.status);
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function webSearch(
  query: string,
  mode: SearchMode = 'basic',
  recency?: Recency
): Promise<SearchResult[]> {
  type Raw = { results: { title: string; url: string; content: string; raw_content?: string | null }[] };
  const data = await tavily<Raw>('search', {
    ...(mode === 'fast-pages'
      ? { query, max_results: 5, search_depth: 'fast', include_raw_content: 'markdown' } // markdown, like extract
      : { query, max_results: 5 }),
    ...(recency ? { time_range: recency } : {})
  });
  return data.results.map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.content,
    ...(x.raw_content ? { content: x.raw_content } : {})
  }));
}

export async function fetchPage(url: string): Promise<string> {
  type Raw = {
    results: { url: string; raw_content: string }[];
    failed_results?: { url: string; error: string }[];
  };
  const data = await tavily<Raw>('extract', { urls: [url] });
  const hit = data.results[0];
  if (!hit) throw new Error(`extract failed for ${url}: ${data.failed_results?.[0]?.error ?? 'no content'}`);
  return hit.raw_content.slice(0, 8000); // cap what goes into the context window
}

/** The schemas the model sees. Same shape as TOOLS in agent_loop.py. */
export const TOOL_SCHEMAS = [
  {
    name: 'web_search',
    description:
      'Search the web. Returns up to 5 results with title, url and a short snippet. Use fetch_page to read a result in full before citing it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'A focused search query. Never put a date in it: use recency instead.'
        },
        recency: {
          type: 'string',
          enum: [...RECENCIES],
          description:
            'Only pages published in the last day, week or month. Only for a question about the present whose results are out of date; it returns fewer results, so prefer week unless the question is about today.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_page',
    description: 'Fetch and read the full text of a web page by URL. Cite only pages you have fetched.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'A URL returned by web_search'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'search_documents',
    description:
      "Search the user's own uploaded documents in this Space. Returns the best-matching passages with their document and page. These passages are already readable in full — do NOT call fetch_page on them. Prefer this over the web when the question is about the user's documents.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, in the words likely to appear in the documents'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'save_memory',
    description:
      'Remember one durable fact or preference the user stated about themselves (what they build in, how they want answers, their role). One sentence, in the third person. Never save trivia from search results, and never save something already listed under what you know about the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact or preference, one sentence' }
      },
      required: ['text']
    }
  }
];
