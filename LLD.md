# Low-Level Design: ResearchLens

## 1. Implementation scope
This document describes the current JavaScript implementation, reviewed on 22 October 2026. The application retrieves source passages; it does not call an AI model or generate research findings.

## 2. Backend modules
### server/app.js
createApp({ dataDir }) initializes the upload directory, restores or creates the workspace, migrates old metadata, registers routes, and returns Express. dataDir defaults to RESEARCHLENS_DATA_DIR or the resolved data directory.

| Function | Responsibility |
| --- | --- |
| save() | Snapshot workspace, serialize writes, replace workspace.json via temporary file |
| activity(message) | Prepend UUID/timestamp event; retain latest 100 |
| summary(doc) | Omit storageName and extraction units; calculate passageCount |
| processDocument(doc) | Read original, extract, replace passages, update status, persist |
| enqueue(doc) | Append processing to a promise queue |
| ingest(files, synthetic) | Validate batch, reserve slots, create metadata, persist, enqueue |
| cleanup(files) | Remove temporary uploaded files |
| httpError(message, status) | Attach HTTP status to an Error |
| asyncRoute(handler) | Forward rejected route promises to Express error middleware |
| app.locals.whenIdle() | Wait for processing and writes, used by tests |

### server/pipeline.js
| Export | Responsibility |
| --- | --- |
| MAX_BYTES | 10 * 1024 * 1024 |
| MAX_DOCUMENTS | 8 |
| sanitizeName(name) | Strip path parts, normalize Unicode, replace unsafe characters, cap name length |
| paragraphSpans(text) | Find numbered non-empty paragraphs and character offsets |
| makePassages(doc, units) | Slice exact overlapping text with source references |
| extractDocument(doc, buffer) | Decode TXT or extract individual PDF pages |
| normalizeTerms(text) | Normalize terms, remove stop words, simplify plurals |
| retrieve(passages, query, limit = 8) | Rank positive lexical matches and diversify selection |

## 3. Stored data
### Workspace
| Field | Meaning |
| --- | --- |
| version | Schema version, currently 2 |
| question | Saved research question |
| documents | Document records |
| passages | Extracted passage records |
| results | Latest retrieval object or null |
| activity | Up to 100 latest document lifecycle events |

### Document
Fields: id (UUID), name (sanitized display name), size (bytes), storageName (UUID plus extension), type (pdf/txt), synthetic (boolean), status (processing/ready/error), createdAt (ISO timestamp), pageCount, paragraphCount, units after extraction, and error on failure.

API document summaries exclude storageName, units, and legacy pages. They add passageCount. Document detail additionally includes its passages.

### Passage
Fields: id, documentId, filename, synthetic, startOffset, endOffset, wordCount, text. PDF passages add page; TXT passages add paragraphStart and paragraphEnd. Offsets refer to the extraction unit: an individual PDF page or the full TXT text.

### Retrieval result
Fields: query, createdAt, kind equal to keyword-retrieval, and passages. Each returned passage additionally carries score, matchedTerms, and rank. Scores are rounded to four decimals for the response and represent lexical relevance only.

### Activity
Fields: id, message, createdAt. These events record document uploads, readiness, failures, and removal. They are not a full audit log of research reasoning.

## 4. HTTP interface
| Method and path | Input | Success / behavior |
| --- | --- | --- |
| GET /api/health | None | status, analysisAvailable=false, retrievalAvailable=true |
| GET /api/workspace | None | Workspace summaries, results, activity, limits |
| PATCH /api/workspace | question string | Save question; reject non-string or over 4,000 characters |
| POST /api/documents | Multipart files or legacy file | 202 with document summaries |
| POST /api/samples | None | 202 with three synthetic document summaries |
| GET /api/documents/:id | Document UUID | Summary and passages; 404 if absent |
| GET /api/passages/:id | Passage UUID | Exact passage; 404 if absent |
| GET /api/documents/:id/file | Document UUID | Download original |
| DELETE /api/documents/:id | Document UUID | { ok: true }; 409 while processing |
| POST /api/retrieve | Non-empty query, max 4,000 characters | Latest ranked retrieval object |
| POST /api/analyze | No implemented analysis contract | 501, code ANALYSIS_NOT_CONFIGURED |

Errors use an error string. Unknown /api endpoints return 404. Multer limit errors return 400. Unexpected server failures use a generic 500 message. A browser Origin outside configured local origins receives 403.

## 5. Ingestion algorithm
1. Multer accepts PDF/TXT extensions and writes under UUID filenames.
2. Enforce file-size, file-count, and multipart field limits.
3. ingest checks non-empty batch, zero-byte files, and total workspace capacity.
4. Reserve document slots synchronously before awaiting persistence to avoid concurrent over-allocation within the process.
5. Persist metadata and enqueue each document. Roll back new metadata and files if initial save fails.
6. Extract in the processing queue; set ready and attach passages, or set error and clear its passages.
7. Save status and add activity.

Failed extraction records remain visible and count toward the workspace cap.

## 6. Text extraction and chunking
PDF extraction first checks for a PDF header in the first 1,024 bytes. PDF.js reads every page using getTextContent(). Text items are joined with spaces or newlines based on layout coordinates and end-of-line markers. Blank pages retain their place in page numbering. If every page is blank, return the OCR-required error.

TXT extraction uses fatal UTF-8 decoding. It rejects null bytes, a PDF header disguised as TXT, and whitespace-only content. Paragraphs are separated by blank lines or form feeds.

Chunking uses whitespace-delimited word offsets. Units with up to 400 words form one passage. Longer units are balanced into roughly 250–400-word passages, normally with 60-word overlap. For 401–439 words, overlap is increased to keep two passages at least 250 words each. Short pages remain short. PDF passages never cross page boundaries. Stored passage text is a direct slice of extracted text.

## 7. Retrieval algorithm
1. Apply Unicode NFKD normalization, remove combining marks, and lowercase.
2. Extract letter/number terms, remove common English stop words and one-character terms, and simplify some plural endings.
3. Deduplicate query terms; compute term frequencies for each passage.
4. Calculate inverse document frequency and BM25-style term contributions, with constants k1=1.2 and b=0.75.
5. Multiply raw score by 0.5 plus the fraction of query terms matched.
6. Discard zero-score candidates.
7. Greedily select results, discounting repeated document sources by 1 + 0.8 * selectedSourceCount and overlapping passages by a factor of 0.65.
8. Return up to eight passages with original raw scores, matched terms, and selection ranks.

This is an in-memory scan recalculated per query. It does not infer synonyms, contradictions, or truth. Diversification changes selection order; returned score is the raw relevance score rather than the adjusted selection score.

## 8. Frontend state and actions
App uses React hooks for workspace, question, active tab, retrieval results, source drawer, selected passage index, upload/search/delete states, and notices/errors.

| Action | Implementation |
| --- | --- |
| refresh | Load workspace and initialize question |
| uploadFiles | Validate basic constraints, submit FormData, refresh |
| loadSamples | POST sample set and refresh |
| findPassages | Save question, submit retrieval, show Overview |
| openSource | Load document detail and locate selected passage |
| removeDocument | DELETE source, clear results, refresh |
| analyze | Call placeholder endpoint and show explanatory notice |

Question persistence is debounced by 500 ms. Workspace polling runs every 1,200 ms while processing exists. Request counters prevent stale retrieval/source responses from replacing newer requests. Changing the question clears current results.

The evidence drawer focuses its close button, traps Tab navigation, supports Escape, and returns focus on close. Tab controls support arrows, Home, and End. EmptyResults provides honest placeholder content for unimplemented views.

## 9. Lifecycle and consistency
Startup clears retrieval results. Old schema documents and interrupted processing records are reprocessed from originals. Existing ready records retain passage IDs on ordinary restart. Uploads, changed questions, successful processing, and deletion invalidate results. The server serializes writes but offers no cross-process locking or database transactions.

Deletion rejects processing documents, removes the original, filters document and passage arrays, clears results, records activity, and saves metadata. Historical activity may still contain the removed filename.

## 10. Tests and operating commands
server/app.test.js uses node:test with isolated temporary data directories. It contains coverage for TXT paragraphs, retrieval, restart persistence, downloads, deletion, PDF blank-page numbering, OCR failure, upload rejection, concurrent document caps, synthetic labeling, chunk boundaries, normalization, and source diversity.

Commands:
- npm install
- npm run dev
- npm test
- npm run build

Build produces frontend assets only. Documentation preparation did not execute the tests or verify the live deployment. Public hosting, AI integration, authentication, cloud persistence, and report generation require additional implementation.
