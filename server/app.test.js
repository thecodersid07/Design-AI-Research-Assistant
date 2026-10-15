import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from './app.js';
import { makePassages, normalizeTerms, retrieve, sanitizeName, MAX_BYTES } from './pipeline.js';

async function fixture(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'researchlens-test-'));
  let app, server, base;
  async function stop() { await app.locals.whenIdle(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  async function start() {
    app = await createApp({ dataDir }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  const request = (route, options) => fetch(base + route, options);
  const json = async (route, options) => (await request(route, options)).json();
  const post = (route, body) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function upload(files) {
    const form = new FormData();
    for (const [name, content] of files) form.append('files', new Blob([content]), name);
    return request('/api/documents', { method: 'POST', body: form });
  }
  try { await run({ dataDir, request, json, post, upload, idle: () => app.locals.whenIdle(), restart: async () => { await stop(); await start(); } }); }
  finally {
    if (server.listening) await stop();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('researchlens-test-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test('multi-upload TXT, exact paragraphs, retrieval, restart, download, deletion and stale-result cleanup', () => fixture(async f => {
  assert.equal((await f.json('/api/health')).analysisAvailable, false);
  const text = 'AI tutoring improves guided practice.\r\n\r\n  Retention remains uncertain.\r\n\r\nThird paragraph has limitations.';
  const response = await f.upload([['notes<>.txt', text], ['second.txt', 'AI tutoring needs teacher supervision.']]);
  assert.equal(response.status, 202);
  const docs = (await response.json()).documents;
  await f.idle();
  const doc = await f.json('/api/documents/' + docs[0].id);
  assert.equal(doc.status, 'ready'); assert.equal(doc.name, 'notes__.txt');
  assert.equal(doc.pageCount, null); assert.equal(doc.paragraphCount, 3);
  assert.equal(doc.passages[0].text, text);
  assert.equal(doc.passages[0].paragraphStart, 1); assert.equal(doc.passages[0].paragraphEnd, 3);
  assert.equal(doc.passages[0].page, undefined); assert.equal(doc.storageName, undefined);
  assert.equal(await (await f.request('/api/documents/' + doc.id + '/file')).text(), text);
  const found = await (await f.post('/api/retrieve', { query: 'AI tutoring' })).json();
  assert.equal(new Set(found.passages.map(p => p.documentId)).size, 2);
  assert.ok(found.passages.every(p => p.score > 0));
  const irrelevant = await (await f.post('/api/retrieve', { query: 'astrophysics' })).json();
  assert.equal(irrelevant.passages.length, 0);
  await f.restart();
  const persisted = await f.json('/api/documents/' + doc.id);
  assert.equal(persisted.passages[0].id, doc.passages[0].id);
  await f.post('/api/retrieve', { query: 'retention' });
  assert.equal((await f.request('/api/documents/' + doc.id, { method: 'DELETE' })).status, 200);
  assert.equal((await f.json('/api/workspace')).results, null);
  assert.equal((await f.request('/api/passages/' + doc.passages[0].id)).status, 404);
  const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'workspace.json'), 'utf8'));
  assert.ok(stored.passages.every(p => p.documentId !== doc.id));
  assert.equal((await fs.readdir(path.join(f.dataDir, 'uploads'))).length, 1);
  assert.ok((await fs.readdir(path.join(f.dataDir, 'uploads'))).every(name => /^[0-9a-f-]{36}\.txt$/.test(name)));
  assert.equal((await f.request('/api/analyze', { method: 'POST' })).status, 501);
}));

test('PDF extraction preserves actual pages, skips blank pages without renumbering, and reports OCR', () => fixture(async f => {
  const response = await f.upload([['paper.pdf', makePdf(['First page evidence.', '', 'Third page limitations.'])], ['scan.pdf', makePdf([''])]]);
  assert.equal(response.status, 202);
  const docs = (await response.json()).documents;
  await f.idle();
  const pdf = await f.json('/api/documents/' + docs[0].id);
  assert.equal(pdf.status, 'ready', pdf.error);
  assert.equal(pdf.pageCount, 3);
  assert.deepEqual(pdf.passages.map(p => p.page), [1, 3]);
  assert.match(pdf.passages[1].text, /Third page limitations/);
  assert.equal(pdf.passages[0].paragraphStart, undefined);
  const scan = await f.json('/api/documents/' + docs[1].id);
  assert.equal(scan.status, 'error'); assert.match(scan.error, /Scanned PDFs need OCR/); assert.equal(scan.passages.length, 0);
}));

test('validation rejects unsupported, zero-byte and oversized files; failed batches leave no files', () => fixture(async f => {
  assert.equal((await f.upload([['good.txt', 'Valid text'], ['bad.exe', 'no']])).status, 400);
  assert.equal((await f.upload([['empty.txt', '']])).status, 400);
  assert.equal((await f.upload([['large.txt', Buffer.alloc(MAX_BYTES + 1, 'a')]])).status, 400);
  assert.equal((await fs.readdir(path.join(f.dataDir, 'uploads'))).length, 0);
  assert.equal((await f.json('/api/workspace')).documents.length, 0);
  const invalidContent = await f.upload([['blank.txt', ' \n\t'], ['disguised.pdf', 'not a pdf']]);
  const docs = (await invalidContent.json()).documents;
  await f.idle();
  for (const doc of docs) assert.equal((await f.json('/api/documents/' + doc.id)).status, 'error');
  assert.equal((await f.post('/api/retrieve', { query: 'test' })).status, 400);
}));

test('eight-document cap is enforced across simultaneous requests and samples stay explicitly synthetic', () => fixture(async f => {
  const samples = await f.request('/api/samples', { method: 'POST' });
  assert.equal(samples.status, 202); await f.idle();
  let workspace = await f.json('/api/workspace');
  assert.equal(workspace.documents.length, 3);
  for (const doc of workspace.documents) {
    assert.equal(doc.synthetic, true);
    const details = await f.json('/api/documents/' + doc.id);
    assert.match(details.passages[0].text, /SYNTHETIC DEMO DOCUMENT/);
    assert.match(details.passages[0].text, /NOT PUBLISHED RESEARCH/);
    assert.ok(details.passages.every(p => p.synthetic));
  }
  assert.equal((await f.request('/api/samples', { method: 'POST' })).status, 409);
  await f.upload(Array.from({ length: 4 }, (_, i) => [`extra${i}.txt`, 'AI tutoring notes.']));
  await f.idle();
  const concurrent = await Promise.all([f.upload([['eighth.txt', 'A relevant source.']]), f.upload([['ninth.txt', 'Another source.']])]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [202, 400]);
  await f.idle();
  workspace = await f.json('/api/workspace');
  assert.equal(workspace.documents.length, 8);
  assert.equal((await fs.readdir(path.join(f.dataDir, 'uploads'))).length, 8);
}));

test('passages are exact overlapping slices within one PDF page; normalization and source diversity', () => {
  const long = Array.from({ length: 950 }, (_, i) => `word${i}`).join('  \n');
  const chunks = makePassages({ id: 'd', name: 'pages.pdf', type: 'pdf' }, [{ number: 1, text: long }, { number: 2, text: 'Short second page.' }]);
  const firstPage = chunks.filter(p => p.page === 1);
  assert.ok(firstPage.length > 1);
  for (const p of firstPage) { assert.ok(p.wordCount >= 250 && p.wordCount <= 400); assert.equal(p.text, long.slice(p.startOffset, p.endOffset)); }
  for (let i = 1; i < firstPage.length; i++) assert.ok(firstPage[i].startOffset < firstPage[i - 1].endOffset);
  assert.equal(chunks.at(-1).text, 'Short second page.');
  assert.deepEqual(normalizeTerms('THE TUTORS, limitations!'), ['tutor', 'limitation']);
  assert.equal(sanitizeName('../../bad<>.txt'), 'bad__.txt');
  const candidates = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, documentId: 'a', text: 'AI tutoring feedback learning', startOffset: i * 500, endOffset: i * 500 + 30 })),
    { id: 'b', documentId: 'b', text: 'AI tutoring feedback learning', startOffset: 0, endOffset: 30 },
    { id: 'c', documentId: 'c', text: 'Unrelated astronomy', startOffset: 0, endOffset: 20 },
  ];
  const ranked = retrieve(candidates, 'AI tutoring feedback', 3);
  assert.equal(new Set(ranked.slice(0, 2).map(p => p.documentId)).size, 2);
  assert.ok(ranked.every(p => p.documentId !== 'c'));
  assert.deepEqual(retrieve(candidates, 'the and of'), []);
});

function makePdf(pageTexts) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const ids = [];
  for (const text of pageTexts) {
    const pageId = objects.length + 1, streamId = pageId + 1;
    ids.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`);
    const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`;
  let file = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(file)); file += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(file), size = objects.length + 1;
  file += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file);
}
