import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Locator } from '@lumina/contract';
import { env } from './env.js';

export type Piece = { text: string; locator: Locator };
export type Parsed = { pieces: Piece[]; pages?: number };

/** A unit is the natural citation grain: a PDF page, a Markdown section, a text file. */
type Unit = { text: string; locator: Locator; startLine: number };

const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function pdfUnits(buf: Buffer): Promise<{ units: Unit[]; pages: number }> {
  const pdf = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  const units: Unit[] = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    const text = tidy(
      content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('')
    );
    if (text) units.push({ text, locator: { page }, startLine: 1 });
  }
  return { units, pages: pdf.numPages };
}

/** One unit per heading; the heading line stays in the text so BM25 sees it. Text before any heading is located by line. */
function markdownUnits(raw: string): Unit[] {
  const lines = tidy(raw).split('\n');
  const units: Unit[] = [];
  let heading: string | null = null;
  let start = 0;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text)
      units.push({ text, locator: heading ? { heading } : { line: start + 1 }, startLine: start + 1 });
    buf = [];
  };
  lines.forEach((line, i) => {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] ?? '').trim();
      start = i;
    }
    buf.push(line);
  });
  flush();
  return units;
}

function textUnits(raw: string): Unit[] {
  const text = tidy(raw);
  return text ? [{ text, locator: { line: 1 }, startLine: 1 }] : [];
}

/** Split a unit that is over the cap on line boundaries; every piece then carries `line` so locators stay unique. */
function split(unit: Unit, maxChars: number): Piece[] {
  if (unit.text.length <= maxChars) return [{ text: unit.text, locator: unit.locator }];
  const lines = unit.text.split('\n');
  const pieces: Piece[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let size = 0;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) pieces.push({ text, locator: { ...unit.locator, line: unit.startLine + bufStart } });
    buf = [];
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (buf.length && size + line.length > maxChars) {
      flush();
      bufStart = i;
    }
    buf.push(line);
    size += line.length + 1;
  }
  flush();
  return pieces;
}

/** PDF by page, Markdown by heading, text as one unit; then cap every unit. Throws on a type the upload route should never have accepted. */
export async function parseDocument(buf: Buffer, mimeType: string): Promise<Parsed> {
  let units: Unit[];
  let pages: number | undefined;
  if (mimeType === 'application/pdf') ({ units, pages } = await pdfUnits(buf));
  else if (mimeType === 'text/markdown') units = markdownUnits(buf.toString('utf8'));
  else if (mimeType === 'text/plain') units = textUnits(buf.toString('utf8'));
  else throw new Error(`unsupported mimeType ${mimeType}`);
  const pieces = units.flatMap((u) => split(u, env.chunkMaxChars));
  return pages !== undefined ? { pieces, pages } : { pieces };
}
