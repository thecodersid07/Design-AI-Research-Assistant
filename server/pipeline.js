import { randomUUID } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 8;
export function sanitizeName(name) {
  const basename = String(name).replaceAll('\\', '/').split('/').pop();
  return basename.normalize('NFKC').replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(-160) || 'document.txt';
}
export function paragraphSpans(text) {
  const spans = [], separators = /(?:\r?\n[\t ]*){2,}|\f+/g;
  let start = 0;
  function add(end) {
    const part = text.slice(start, end), first = part.search(/\S/u);
    if (first !== -1) spans.push({ number: spans.length + 1, start: start + first, end: start + part.trimEnd().length });
  }
  for (const match of text.matchAll(separators)) { add(match.index); start = match.index + match[0].length; }
  add(text.length);
  return spans;
}
// Offsets address the original extracted text. Chunking never rewrites whitespace.
export function makePassages(doc, units) {
  return units.flatMap(unit => {
    const words = [...unit.text.matchAll(/\S+/gu)];
    if (!words.length) return [];
    const count = words.length <= 400 ? 1 : Math.ceil((words.length - 60) / 340);
    const overlap = count === 2 && words.length < 440 ? 500 - words.length : 60;
    const window = Math.ceil((words.length + (count - 1) * overlap) / count);
    const paragraphs = doc.type === 'txt' ? paragraphSpans(unit.text) : [];
    const passages = [];
    for (let from = 0; from < words.length; from += window - overlap) {
      const to = Math.min(from + window, words.length);
      const start = words[from].index, end = words[to - 1].index + words[to - 1][0].length;
      const covered = paragraphs.filter(p => p.end > start && p.start < end);
      passages.push({ id: randomUUID(), documentId: doc.id, filename: doc.name, synthetic: !!doc.synthetic,
        ...(doc.type === 'pdf' ? { page: unit.number } : { paragraphStart: covered[0].number, paragraphEnd: covered.at(-1).number }),
        startOffset: start, endOffset: end, wordCount: to - from, text: unit.text.slice(start, end) });
      if (to === words.length) break;
    }
    return passages;
  });
}
export async function extractDocument(doc, buffer) {
  let units, pageCount = null, paragraphCount = null;
  if (doc.type === 'pdf') {
    if (!buffer.subarray(0, 1024).toString().includes('%PDF-')) throw new Error('This file is not a valid PDF.');
    const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true });
    try {
      const pdf = await task.promise;
      pageCount = pdf.numPages; units = [];
      for (let number = 1; number <= pageCount; number++) {
        const page = await pdf.getPage(number);
        const { items } = await page.getTextContent();
        let text = '', previousY;
        for (const item of items) {
          if (typeof item.str !== 'string') continue;
          const y = item.transform?.[5];
          if (text && !text.endsWith('\n')) text += previousY !== undefined && previousY !== y ? '\n' : ' ';
          text += item.str;
          if (item.hasEOL) text += '\n';
          previousY = y;
        }
        units.push({ number, text }); page.cleanup();
      }
    } finally { await task.destroy(); }
    if (!units.some(unit => unit.text.trim())) throw new Error('No extractable text found. Scanned PDFs need OCR and are unsupported in this prototype.');
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('This TXT file must contain UTF-8 text.'); }
    if (/\x00/u.test(text) || text.startsWith('%PDF-')) throw new Error('This file is not a valid TXT document.');
    if (!text.trim()) throw new Error('Empty documents are not supported.');
    units = [{ text }]; paragraphCount = paragraphSpans(text).length;
  }
  return { units, pageCount, paragraphCount, passages: makePassages(doc, units) };
}
const STOP = new Set('a an the and or but of to in on for from with by is are was were be been being do does did how what which who when where why can could should would will have has had it its this that these those as at about into than then there their they we our your you not'.split(' '));
export function normalizeTerms(text) {
  return (text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(term => !STOP.has(term) && term.length > 1)
    .map(term => term.length > 4 && term.endsWith('ies') ? term.slice(0, -3) + 'y' : term.length > 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term);
}
export function retrieve(passages, query, limit = 8) {
  const terms = [...new Set(normalizeTerms(query))];
  if (!terms.length || !passages.length) return [];
  const indexed = passages.map(passage => {
    const tokens = normalizeTerms(passage.text), frequencies = new Map();
    tokens.forEach(term => frequencies.set(term, (frequencies.get(term) || 0) + 1));
    return { passage, tokens, frequencies };
  });
  const avg = indexed.reduce((sum, row) => sum + row.tokens.length, 0) / indexed.length || 1;
  const idf = new Map(terms.map(term => {
    const frequency = indexed.filter(row => row.frequencies.has(term)).length;
    return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  const candidates = indexed.map(row => {
    let score = 0;
    const matchedTerms = [];
    for (const term of terms) {
      const tf = row.frequencies.get(term) || 0;
      if (tf) { matchedTerms.push(term); score += idf.get(term) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * row.tokens.length / avg)); }
    }
    score *= 0.5 + matchedTerms.length / terms.length;
    return { ...row.passage, score, matchedTerms };
  }).filter(row => row.score > 0);
  const results = [], sourceCounts = new Map();
  while (candidates.length && results.length < limit) {
    candidates.sort((a, b) => adjusted(b) - adjusted(a) || b.score - a.score || a.id.localeCompare(b.id));
    const next = candidates.shift();
    results.push({ ...next, score: Number(next.score.toFixed(4)), rank: results.length + 1 });
    sourceCounts.set(next.documentId, (sourceCounts.get(next.documentId) || 0) + 1);
  }
  function adjusted(row) {
    const overlapping = results.some(prior => prior.documentId === row.documentId && prior.page === row.page && prior.startOffset < row.endOffset && row.startOffset < prior.endOffset);
    return row.score / (1 + 0.8 * (sourceCounts.get(row.documentId) || 0)) * (overlapping ? 0.65 : 1);
  }
  return results;
}
