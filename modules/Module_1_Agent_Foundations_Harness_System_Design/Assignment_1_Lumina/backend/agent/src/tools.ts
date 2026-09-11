import { secrets } from './env.js';

export type SearchResult = { title: string; url: string; snippet: string };

/** The provider itself failed, not one page. This ends the run (rule A1); a single bad fetch does not. */
export class ProviderError extends Error {}

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
    if (path === 'search' || r.status >= 500) throw new ProviderError(msg);
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  type Raw = { results: { title: string; url: string; content: string }[] };
  const data = await tavily<Raw>('search', { query, max_results: 5 });
  return data.results.map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.content
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
  return hit.raw_content.slice(0, 12000); // cap what goes into the context window
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
          description: 'A focused search query'
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
  }
];
