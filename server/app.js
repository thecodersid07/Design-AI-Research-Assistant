import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractDocument, sanitizeName, retrieve, MAX_BYTES, MAX_DOCUMENTS } from './pipeline.js';

export async function createApp({ dataDir = process.env.RESEARCHLENS_DATA_DIR || path.resolve('data') } = {}) {
  dataDir = path.resolve(dataDir);
  const app = express(), uploadDir = path.join(dataDir, 'uploads'), metadataPath = path.join(dataDir, 'workspace.json');
  await fs.mkdir(uploadDir, { recursive: true });
  let workspace;
  try { workspace = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Workspace metadata could not be read. Restore workspace.json before restarting.', { cause: error });
    workspace = { version: 2, question: '', documents: [], passages: [], results: null, activity: [] };
  }
  let writes = Promise.resolve(), processing = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(workspace, null, 2);
    const next = writes.catch(() => {}).then(async () => { await fs.writeFile(`${metadataPath}.tmp`, snapshot); await fs.rename(`${metadataPath}.tmp`, metadataPath); });
    writes = next; return next;
  }
  function activity(message) { workspace.activity.unshift({ id: randomUUID(), message, createdAt: new Date().toISOString() }); workspace.activity = workspace.activity.slice(0, 100); }
  function summary({ storageName, units, pages, ...doc }) { return { ...doc, passageCount: workspace.passages.filter(p => p.documentId === doc.id).length }; }
  workspace.passages ||= [];
  workspace.results = null;
  const migrating = workspace.version !== 2;
  for (const doc of workspace.documents) {
    doc.name = sanitizeName(doc.name);
    if (migrating || doc.status === 'processing') { doc.status = 'processing'; delete doc.pages; delete doc.error; }
  }
  if (migrating) workspace.passages = [];
  workspace.version = 2;
  await save();
  async function processDocument(doc) {
    try {
      if (!['txt', 'pdf'].includes(doc.type)) throw new Error('Only PDF and TXT documents are supported. Remove this document and upload a TXT or PDF version.');
      const extracted = await extractDocument(doc, await fs.readFile(path.join(uploadDir, doc.storageName)));
      if (!workspace.documents.includes(doc)) return;
      const { passages, ...fields } = extracted;
      Object.assign(doc, fields, { status: 'ready' });
      workspace.passages = workspace.passages.filter(p => p.documentId !== doc.id).concat(passages);
      workspace.results = null;
      activity(`${doc.name} is ready to read`);
    } catch (error) {
      if (!workspace.documents.includes(doc)) return;
      doc.status = 'error';
      doc.error = /OCR|TXT|Empty|valid PDF|Only PDF/.test(error.message) ? error.message : 'Could not read this document. Try an unencrypted, undamaged PDF or a UTF-8 TXT file.';
      workspace.passages = workspace.passages.filter(p => p.documentId !== doc.id);
      activity(`Could not read ${doc.name}`);
    }
    await save();
  }
  function enqueue(doc) { processing = processing.then(() => processDocument(doc)).catch(error => console.error('Could not save processing status:', error.message)); }
  workspace.documents.filter(doc => doc.status === 'processing').forEach(enqueue);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    const origins = ['127.0.0.1', 'localhost'].flatMap(host => [5173, Number(process.env.PORT || 3001)].map(port => `http://${host}:${port}`));
    if (req.get('origin') && !origins.includes(req.get('origin'))) return res.status(403).json({ error: 'This workspace only accepts local requests.' });
    next();
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok', analysisAvailable: false, retrievalAvailable: true }));
  app.get('/api/workspace', (req, res) => res.json({ version: 2, question: workspace.question, documents: workspace.documents.map(summary), activity: workspace.activity, results: workspace.results, limits: { maxDocuments: MAX_DOCUMENTS, maxBytes: MAX_BYTES } }));
  app.patch('/api/workspace', asyncRoute(async (req, res) => {
    if (typeof req.body.question !== 'string' || req.body.question.length > 4000) return res.status(400).json({ error: 'Enter a question of up to 4,000 characters.' });
    if (workspace.question !== req.body.question) workspace.results = null;
    workspace.question = req.body.question; await save(); res.json({ question: workspace.question });
  }));
  const upload = multer({ storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase()) }), limits: { fileSize: MAX_BYTES, files: MAX_DOCUMENTS, fields: 0 }, fileFilter: (req, file, cb) => {
    if (!['.pdf', '.txt'].includes(path.extname(file.originalname).toLowerCase())) return cb(httpError('Choose PDF or TXT files only.', 400));
    cb(null, true);
  } });
  async function cleanup(files) { await Promise.all(files.map(file => fs.rm(file.path, { force: true }))); }
  async function ingest(files, synthetic = false) {
    const failure = !files.length ? 'Choose documents to upload.' : files.some(file => !file.size) ? 'Empty files are not supported.' : workspace.documents.length + files.length > MAX_DOCUMENTS ? 'This workspace can hold up to 8 documents. Remove a document before adding more.' : null;
    if (failure) { await cleanup(files); throw httpError(failure, 400); }
    // Reserve slots before the first await so concurrent requests cannot exceed the cap.
    const docs = files.map(file => ({ id: randomUUID(), name: sanitizeName(file.originalname), size: file.size, storageName: file.filename, type: path.extname(file.originalname).slice(1).toLowerCase(), synthetic, status: 'processing', createdAt: new Date().toISOString(), pageCount: null, paragraphCount: null }));
    workspace.documents.push(...docs); workspace.results = null;
    docs.forEach(doc => activity(`Uploaded ${doc.name}${synthetic ? ' (synthetic demo)' : ''}`));
    try { await save(); }
    catch (error) { workspace.documents = workspace.documents.filter(doc => !docs.includes(doc)); await cleanup(files); throw error; }
    docs.forEach(enqueue);
    return docs.map(summary);
  }
  app.post('/api/documents', upload.fields([{ name: 'files', maxCount: 8 }, { name: 'file', maxCount: 8 }]), asyncRoute(async (req, res) => {
    const docs = await ingest(Object.values(req.files || {}).flat());
    res.status(202).json({ documents: docs, ...(docs.length === 1 ? { id: docs[0].id, status: docs[0].status } : {}) });
  }));
  const sampleDir = fileURLToPath(new URL('../samples/', import.meta.url));
  const sampleNames = ['ai-tutoring-guided-practice.txt', 'ai-tutoring-independent-learning.txt', 'ai-tutoring-access-and-limitations.txt'];
  app.post('/api/samples', asyncRoute(async (req, res) => {
    if (workspace.documents.some(doc => doc.synthetic)) return res.status(409).json({ error: 'Sample documents are already loaded. Remove them before loading the sample set again.' });
    if (workspace.documents.length + 3 > MAX_DOCUMENTS) return res.status(400).json({ error: 'The sample set needs three available document slots.' });
    const files = [];
    try {
      for (const name of sampleNames) {
        const buffer = await fs.readFile(path.join(sampleDir, name));
        const filename = randomUUID() + '.txt', filePath = path.join(uploadDir, filename);
        await fs.writeFile(filePath, buffer);
        files.push({ originalname: name, filename, path: filePath, size: buffer.length });
      }
      if (workspace.documents.some(doc => doc.synthetic)) { await cleanup(files); return res.status(409).json({ error: 'Sample documents are already loaded.' }); }
      res.status(202).json({ documents: await ingest(files, true) });
    } catch (error) { await cleanup(files); throw error; }
  }));
  app.get('/api/documents/:id', (req, res) => {
    const doc = workspace.documents.find(doc => doc.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    res.json({ ...summary(doc), passages: workspace.passages.filter(p => p.documentId === doc.id) });
  });
  app.get('/api/passages/:id', (req, res) => {
    const passage = workspace.passages.find(p => p.id === req.params.id);
    if (!passage) return res.status(404).json({ error: 'Passage not found.' });
    res.json(passage);
  });
  app.get('/api/documents/:id/file', (req, res) => {
    const doc = workspace.documents.find(doc => doc.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    res.download(path.join(uploadDir, doc.storageName), doc.name);
  });
  app.delete('/api/documents/:id', asyncRoute(async (req, res) => {
    const doc = workspace.documents.find(doc => doc.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.status === 'processing') return res.status(409).json({ error: 'Wait for this document to finish processing.' });
    await fs.rm(path.join(uploadDir, doc.storageName), { force: true });
    workspace.documents = workspace.documents.filter(item => item.id !== doc.id);
    workspace.passages = workspace.passages.filter(item => item.documentId !== doc.id);
    workspace.results = null;
    activity(`Removed ${doc.name}`); await save(); res.json({ ok: true });
  }));
  app.post('/api/retrieve', asyncRoute(async (req, res) => {
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 4000) return res.status(400).json({ error: 'Enter a question of 1-4,000 characters.' });
    const ids = new Set(workspace.documents.filter(doc => doc.status === 'ready').map(doc => doc.id));
    if (!ids.size) return res.status(400).json({ error: 'Add a readable document first.' });
    const results = { query, createdAt: new Date().toISOString(), kind: 'keyword-retrieval', passages: retrieve(workspace.passages.filter(p => ids.has(p.documentId)), query) };
    workspace.results = results; await save(); res.json(results);
  }));
  app.post('/api/analyze', (req, res) => res.status(501).json({ error: 'AI analysis is not connected. Use Find passages to explore matching source text.', code: 'ANALYSIS_NOT_CONFIGURED' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error, req, res, next) => {
    const status = error instanceof multer.MulterError ? 400 : error.status || 500;
    const messages = { LIMIT_FILE_SIZE: 'This file is too large. The limit is 10 MB per file.', LIMIT_FILE_COUNT: 'Upload no more than 8 documents.', LIMIT_UNEXPECTED_FILE: 'Upload no more than 8 PDF or TXT documents.' };
    res.status(status).json({ error: messages[error.code] || (status < 500 ? error.message : 'Something went wrong saving your workspace. Please try again.') });
  });
  app.locals.whenIdle = () => processing.then(() => writes);
  return app;
}
function httpError(message, status) { return Object.assign(new Error(message), { status }); }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
