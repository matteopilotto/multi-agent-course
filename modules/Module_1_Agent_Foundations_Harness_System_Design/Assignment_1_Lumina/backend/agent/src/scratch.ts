/**
 * recall@5 over the gold set, straight against retrieval. Scored the way benchmark/bench.mjs
 * scores it — doc stem plus page for the PDFs, anchor overlap for the markdown — so the number
 * is comparable to the gate's, minus whatever the loop does on top. Run all three branches:
 * the point of the fusion is the gap between them.
 *
 *   cd backend/agent && SPACE_ID=spc_... npx tsx src/scratch.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from './env.js';
import { embed } from './embed.js';
import { hybridSearchChunks, textSearchChunks, vectorSearchChunks, type ChunkHit } from './retrieval.js';
import { documentTitles } from './documents.js';

const spaceId = process.env.SPACE_ID ?? '';
const userId = process.env.USER_ID ?? 'dev';
if (!spaceId) throw new Error('SPACE_ID=spc_... is required');

type Gold = { id: string; question: string; doc: string; page?: number; anchor?: string };
const gold: Gold[] = readFileSync(resolve(process.cwd(), '../../eval/gold/rag_gold.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Gold);

const stem = (v: string) =>
  v
    .toLowerCase()
    .replace(/\.(pdf|md|txt)$/, '')
    .replace(/[^a-z0-9]/g, '');
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
/** The bench's grounding test in miniature: six consecutive anchor tokens inside the chunk. */
function anchored(anchor: string, text: string): boolean {
  const a = words(anchor);
  const t = words(text).join(' ');
  const n = Math.min(6, a.length);
  for (let i = 0; i + n <= a.length; i++) if (t.includes(a.slice(i, i + n).join(' '))) return true;
  return false;
}

async function score(label: string, run: (q: string) => Promise<ChunkHit[]>): Promise<void> {
  let hit = 0;
  const missed: string[] = [];
  for (const g of gold) {
    const top = (await run(g.question)).slice(0, 5);
    const titles = await documentTitles([...new Set(top.map((h) => h.docId))]);
    const ok = top.some((h) => {
      const t = stem(titles.get(h.docId) ?? '');
      if (!t || (!t.includes(stem(g.doc)) && !stem(g.doc).includes(t))) return false;
      if (g.page) return h.locator.page === g.page;
      if (g.anchor) return anchored(g.anchor, h.text);
      return true;
    });
    if (ok) hit++;
    else missed.push(g.id);
  }
  console.log(
    `${label.padEnd(7)} recall@5 ${(hit / gold.length).toFixed(2)}  (${hit}/${gold.length})  missed: ${missed.join(' ') || '-'}`
  );
}

await score('dense', (q) => embed(q).then((v) => vectorSearchChunks(spaceId, userId, v, env.ragTopK)));
await score('bm25', (q) => textSearchChunks(spaceId, userId, q, env.ragTopK));
await score('hybrid', (q) => hybridSearchChunks(spaceId, userId, q));
process.exit(0);
