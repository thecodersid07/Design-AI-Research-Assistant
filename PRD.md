# Product Requirements Document: ResearchLens

## 1. Product summary
ResearchLens addresses PS 03, Intelligent Research & Knowledge Synthesis. Its long-term goal is to help users retrieve, compare, and synthesize evidence across documents while keeping conclusions traceable to source material.

The current release is a document exploration prototype. It provides uploads, text extraction, keyword-based passage search, and an evidence viewer. AI synthesis is not implemented.

## 2. Problem
Students, researchers, and professionals spend time locating relevant passages across disconnected documents. Summaries can obscure context or omit evidence. Users need a workspace that keeps sources together and makes relevant text easy to inspect before drawing conclusions.

## 3. Users and needs
| User | Need |
| --- | --- |
| Student | Locate passages relevant to an assignment question |
| Researcher | Inspect evidence across a small collection of papers |
| Professional | Search reports and retain the location of useful information |

The current scope is a single personal workspace, not a shared or multi-account service.

## 4. Goals
1. Collect supported documents in one workspace.
2. Retrieve relevant source passages for a user-entered question.
3. Preserve PDF page numbers and TXT paragraph references.
4. Make original evidence accessible from search results.
5. Clearly distinguish retrieval from generated analysis and synthetic documents from published research.

## 5. Scope and implementation status
| Requirement | Current implementation |
| --- | --- |
| Accept a research objective | Question entry and persistence; no automated decomposition |
| Retrieve relevant information | Lexical search of uploaded PDF/TXT passages |
| Synthesize and compare findings | Planned; Comparison is a placeholder |
| Validate and cite evidence | Passage-to-source references exist; claim validation is planned |
| Generate research deliverables | Planned; original-file downloads exist, research-report export does not |
| Track research progress | Upload, readiness, failure, and deletion activity; no full research-session history |

## 6. Functional requirements
### FR-01: Document library
Users can select or drag multiple PDF/TXT files into the workspace. Enforce eight documents maximum and 10 MiB per file. Show name, type, size, processing state, relevant counts, and synthetic label.

Acceptance: a valid upload returns accepted status and becomes ready or displays an extraction error. Unsupported, zero-byte, oversized, and over-capacity uploads are rejected with a useful message.

### FR-02: Extraction and passages
Extract PDF text page by page, including correct numbering after blank pages. Decode TXT as UTF-8 and reference blank-line-separated paragraphs. Preserve extracted text when slicing overlapping passages.

Acceptance: clicking a passage displays its stored text and correct physical PDF page or TXT paragraph range. Scanned PDFs without extractable text explain that OCR is unsupported.

### FR-03: Research question
Allow a question up to 4,000 characters and save it to the workspace.

Acceptance: a changed question clears old retrieval results. Empty queries cannot trigger valid retrieval.

### FR-04: Passage search
Retrieve up to eight positively matching passages from ready documents, ranked by lexical relevance and diversified across sources where relevant.

Acceptance: no matching terms produces an empty result. Scores are described as text relevance, never confidence or verified truth.

### FR-05: Evidence viewer
Open a document or retrieved passage in a drawer. Display filename, page/paragraph reference, exact extracted passage, synthetic status, and original download link.

Acceptance: previous/next controls navigate passages; Escape closes the drawer and focus returns to the triggering control.

### FR-06: Persistence and deletion
Persist originals, metadata, passages, question, and activity locally on the server. Resume interrupted extraction on restart. Allow removal after processing completes.

Acceptance: existing passages survive ordinary restarts with stable IDs. Deleted passages are no longer retrievable. Old search results are cleared after deletion and restart.

### FR-07: Sample dataset
Load three fictional AI tutoring documents only when requested. Label them as synthetic and not published research.

Acceptance: samples consume three document slots; repeated loading is rejected while synthetic documents remain.

### FR-08: Honest analysis state
The interface must not fabricate research findings.

Acceptance: the Analyze endpoint returns 501 with ANALYSIS_NOT_CONFIGURED. Comparison and Evidence Gaps remain explanatory placeholders.

## 7. User journey
1. Open the local workspace.
2. Upload documents or explicitly load synthetic samples.
3. Wait for ready status and address extraction errors.
4. Enter a question and select Find passages.
5. Inspect matching passages and original references.
6. Download an original source or remove an unneeded document.

## 8. Non-functional requirements
| Area | Requirement and limitation |
| --- | --- |
| Traceability | Keep document IDs and page/paragraph references on every passage |
| Integrity | Preserve extracted text; explain that PDF layout may differ |
| Usability | Clear empty/loading/error states, keyboard-accessible tabs and drawer |
| Persistence | Serialize JSON writes and use temporary-file replacement |
| Transparency | State that search is lexical and AI analysis is unavailable |
| Privacy | Current processing is local to the server, without model calls |
| Scale | Personal prototype with a hard eight-document limit; no scale SLA |
| Security | Validate uploads; public multi-user security remains out of scope |

## 9. Success criteria
The prototype is acceptable when a user can upload valid sources, retrieve relevant verbatim passages, open correct references, restart without losing source content, and delete sources without retaining stale results. Negative cases must fail clearly. These are acceptance criteria, not a claim that a deployment has passed them.

## 10. Out of scope for this release
Live web search, OCR, semantic embeddings, AI-generated answers, contradiction detection, claim verification, report export, full research history, authentication, collaboration, and multi-user cloud storage.

## 11. Roadmap
- Next: structured objective decomposition and evidence-grounded synthesis.
- Then: claim-level citations, contradiction caveats, comparison tables, and evidence gaps.
- Later: downloadable research briefs, saved sessions, authentication, and production storage.

Each AI feature must distinguish supported statements, inferences, conflicting evidence, and missing evidence. A citation alone must not be treated as proof.

## 12. Risks and dependencies
Keyword search can miss synonyms. PDF extraction can lose visual structure. Scanned or encrypted documents may fail. Filesystem persistence assumes one server process. A static frontend host does not supply the existing API or durable uploads. Synthetic samples cannot be used as real research evidence.

## 13. Verification
Source references: README.md, package.json, server/app.js, server/pipeline.js, src/App.jsx, and server/app.test.js. Review date: 22 October 2026. Existing automated checks can be run with npm test and npm run build; this document records requirements and code behavior, not fresh execution results.
