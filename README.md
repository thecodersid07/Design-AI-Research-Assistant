# ResearchLens

A local research workspace using React, Vite, plain CSS, Express, filesystem uploads, and JSON metadata. **AI analysis is not implemented.** Find passages returns ranked, verbatim source excerpts, never generated research findings.

## Start

Requires **Node.js 22.13+** (Node 24 recommended) and npm, matching the maintained Mozilla PDF.js dependency.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Both services bind to localhost. Vite proxies `/api` to Express on port 3001. Optional configuration is documented in `.env.example`; changing `PORT` updates the server and proxy.

## Document pipeline

- Select multiple **PDF or UTF-8 TXT** files or drop them in the library. Limits: **10 MB per file, 8 documents per workspace**, including documents with processing errors. A batch that fails upload validation is rejected as a whole; files that fail extraction remain visible with an error and can be removed.
- Server validation rejects unsupported extensions, zero-byte files, oversized files, and excess documents. Extraction rejects whitespace-only text, invalid UTF-8, binary text, malformed PDFs, and PDFs without extractable text. Display names are sanitized; stored filenames use generated UUIDs.
- PDF extraction uses [Mozilla PDF.js](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs), one physical page at a time. Blank pages still count toward the total. Passages keep actual page numbers starting at 1 and never span different PDF pages. Scanned PDFs require OCR and are unsupported.
- TXT references use **paragraph numbers**, not page numbers. Paragraphs are separated by blank lines (or form feeds). Wrapped lines within a paragraph do not create new references.
- Text is divided into overlapping passages of roughly **250-400 words** (normally 60 words of overlap). Short documents and short PDF pages produce shorter passages. The 401-439-word boundary uses a slightly larger overlap to keep both passages at least 250 words.
- Each passage stores its ID, document ID, sanitized filename, synthetic-demo flag, page or paragraph range, word count, character offsets, and exact extracted text. Text is sliced without rewriting whitespace. The extracted PDF text can differ from the PDF's visual layout.
- The evidence drawer opens any document's passages or a retrieved passage directly, with its original reference and previous/next passage navigation.

## Passage retrieval

Enter a question and click **Find passages**. Search normalizes Unicode, case and punctuation, removes common English stop words, and handles simple plurals. It uses BM25-style term weighting with query coverage, then discounts repeated sources and overlapping passages to improve diversity. Only passages with matching terms are eligible; no matches means an empty result.

Relevance scores measure keyword similarity, not truth, confidence, or evidence quality. This is lexical retrieval: it does not understand synonyms or infer answers. **Analyze** remains a clearly explained placeholder and is disabled without readable documents. Comparison and Evidence Gaps do not contain invented results.

## Synthetic samples

Click **Load sample documents** to explicitly add three TXT files from `samples/`. They describe fictional AI tutoring scenarios with differing outcomes and limitations: guided practice, independent learning, and access/teacher workload. All three are labeled **synthetic demo documents, not published research**, both in their content and in the library, retrieved results, and evidence drawer. Samples use three of the eight document slots and are never loaded automatically.

## Local persistence

`data/workspace.json` stores metadata, source text, passages, question, activity, and the latest retrieval result. Original files live under `data/uploads/`. Both are Git-ignored. Writes are serialized and atomically replaced. Existing v1 workspaces are migrated by re-extracting preserved uploads; interrupted processing resumes on restart. Passage IDs remain stable across ordinary restarts. Retrieval results are cleared on restart, question changes, uploads, processing changes, and deletion.

Deletion removes the original file, metadata, passages, and stale retrieval results. Activity retains the document name. Wait for processing to finish before deleting. This is a single-process personal prototype; it does not add authentication, a database, embeddings, external storage, or model calls.

## Checks

```sh
npm test
npm run build
```

Tests use isolated temporary workspaces. They cover multiple TXT uploads, exact paragraph text, PDF extraction and blank-page numbering, OCR errors, zero-byte/unsupported/oversized files, concurrent workspace limits, synthetic samples, overlap and source diversity, restart persistence, downloads, deletion, and stale-result cleanup.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health, analysis and retrieval availability |
| GET | `/api/workspace` | Document summaries, limits, question, activity, latest retrieval |
| PATCH | `/api/workspace` | Save `{ "question": "..." }` |
| POST | `/api/documents` | Multipart `files` (or legacy `file`), multiple files; returns 202 |
| POST | `/api/samples` | Explicitly load three synthetic samples |
| GET | `/api/documents/:id` | Metadata, processing status/error, extracted passages |
| GET | `/api/passages/:id` | One passage with exact text and reference |
| GET | `/api/documents/:id/file` | Download original |
| DELETE | `/api/documents/:id` | Remove completed document, passages, and results |
| POST | `/api/retrieve` | `{ "query": "..." }`; up to 8 ranked passages |
| POST | `/api/analyze` | Explicit 501 `ANALYSIS_NOT_CONFIGURED` |

`server/pipeline.js` contains extraction, passage generation, and ranked retrieval. `server/app.js` owns upload validation, persistence, migration, and routes. `src/App.jsx` and `src/styles.css` contain the preserved dashboard and connected evidence UI.
