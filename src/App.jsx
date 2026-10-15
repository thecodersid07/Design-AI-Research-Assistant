import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, FileText, Files, FlaskConical, GitCompareArrows, Layers3, LoaderCircle, PanelRightClose, Plus, Search, ShieldCheck, Sparkles, Trash2, Upload, X, AlertCircle, ScanText } from 'lucide-react';

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The workspace could not be reached.');
  return body;
}
const tabs = [{ name: 'Overview', icon: Layers3 }, { name: 'Comparison', icon: GitCompareArrows }, { name: 'Evidence Gaps', icon: ScanText }, { name: 'Activity', icon: Clock3 }];
const sizeLabel = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const reference = p => !p ? '' : p.page ? `Page ${p.page}` : p.paragraphStart === p.paragraphEnd ? `Paragraph ${p.paragraphStart}` : `Paragraphs ${p.paragraphStart}–${p.paragraphEnd}`;

export default function App() {
  const [workspace, setWorkspace] = useState(null);
  const [question, setQuestion] = useState('');
  const [tab, setTab] = useState('Overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [source, setSource] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [saveState, setSaveState] = useState('');
  const [deleting, setDeleting] = useState(null);
  const fileInput = useRef(null);
  const initialized = useRef(false);
  const sourceRequest = useRef(0);
  const retrievalRequest = useRef(0);
  const closeButton = useRef(null);
  const drawerRef = useRef(null);
  const sourceTrigger = useRef(null);
  const refresh = useCallback(async () => {
    const data = await api('/api/workspace');
    setWorkspace(data);
    setResults(data.results);
    if (!initialized.current) { setQuestion(data.question); initialized.current = true; }
    return data;
  }, []);
  useEffect(() => { refresh().catch(() => setError('Cannot connect to your workspace. Make sure the local server is running, then retry.')); }, [refresh]);
  const processing = workspace?.documents.some(doc => doc.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => refresh().catch(() => setError('Connection interrupted. Please retry.')), 1200);
    return () => clearInterval(timer);
  }, [processing, refresh]);
  useEffect(() => {
    if (!drawer || !source || source.status !== 'processing') return;
    const current = workspace?.documents.find(doc => doc.id === source.id);
    if (current && current.status !== 'processing') {
      const request = ++sourceRequest.current;
      api(`/api/documents/${source.id}`).then(data => { if (request === sourceRequest.current) { setSource(data); setPage(0); } }).catch(error => setSourceError(error.message));
    }
  }, [workspace, drawer, source]);
  useEffect(() => {
    if (!initialized.current) return;
    if (question === workspace?.question) return;
    setSaveState('Saving…');
    const timer = setTimeout(() => {
      api('/api/workspace', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })
        .then(() => setSaveState('Saved locally')).catch(() => setSaveState('Could not save question'));
    }, 500);
    return () => clearTimeout(timer);
  }, [question, workspace?.question]);
  useEffect(() => {
    if (!drawer) return;
    closeButton.current?.focus();
    const escape = event => {
      if (event.key === 'Escape') setDrawer(false);
      if (event.key === 'Tab') {
        const focusable = drawerRef.current?.querySelectorAll('button:not(:disabled), a[href]');
        if (!focusable?.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); sourceTrigger.current?.focus(); };
  }, [drawer]);
  async function uploadFiles(files) {
    if (!files?.length || uploading) return;
    setError(''); setNotice('');
    const selected = Array.from(files);
    if (selected.some(file => !/\.(pdf|txt)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024)) { setError('Choose non-empty PDF or TXT files up to 10 MB each.'); return; }
    if (selected.length + (workspace?.documents.length || 0) > 8) { setError('This workspace holds up to 8 documents. Remove a document before adding more.'); return; }
    setUploading(true);
    retrievalRequest.current++;
    const data = new FormData(); selected.forEach(file => data.append('files', file));
    try { await api('/api/documents', { method: 'POST', body: data }); setResults(null); await refresh(); }
    catch (error) { setError(error.message); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function loadSamples() {
    setUploading(true); setError('');
    retrievalRequest.current++;
    try { await api('/api/samples', { method: 'POST' }); setResults(null); await refresh(); }
    catch (error) { setError(error.message); }
    finally { setUploading(false); }
  }
  async function findPassages() {
    setSearching(true); setError(''); setNotice(''); setResults(null);
    const request = ++retrievalRequest.current;
    try {
      await api('/api/workspace', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const found = await api('/api/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: question }) });
      if (request === retrievalRequest.current) { setResults(found); setTab('Overview'); }
    } catch (error) { setError(error.message); }
    finally { setSearching(false); }
  }
  async function openSource(doc, event, passageId) {
    sourceTrigger.current = event?.currentTarget;
    const request = ++sourceRequest.current;
    setDrawer(true); setSource(null); setSourceError(''); setPage(0); setSourceLoading(true);
    try { const data = await api(`/api/documents/${doc.id}`); if (request === sourceRequest.current) { setSource(data); setPage(Math.max(0, data.passages.findIndex(p => p.id === passageId))); } }
    catch (error) { if (request === sourceRequest.current) setSourceError(error.message); }
    finally { if (request === sourceRequest.current) setSourceLoading(false); }
  }
  async function removeDocument(doc) {
    setDeleting(doc.id); setError('');
    retrievalRequest.current++;
    try {
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      if (source?.id === doc.id) { setDrawer(false); setSource(null); }
      setResults(null);
      await refresh();
    } catch (error) { setError(error.message); }
    finally { setDeleting(null); }
  }
  async function analyze(event) {
    event.preventDefault(); setAnalyzing(true); setNotice(''); setError('');
    try {
      await api('/api/workspace', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
    } catch (error) { setNotice(error.message); }
    finally { setAnalyzing(false); }
  }
  const documents = workspace?.documents || [];
  const ready = documents.filter(doc => doc.status === 'ready' && doc.passageCount > 0).length;
  const filtered = documents.filter(doc => doc.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="ResearchLens home"><span className="brand-icon"><Layers3 size={22}/></span><span>Research<span className="brand-light">Lens</span><small>CLARITY THROUGH EVIDENCE</small></span></a>
      <div className="workspace-nav"><span className="workspace-avatar">R</span><div>Research workspace<small>Personal workspace</small></div><span className="local-dot" title="Stored on this device"/></div>
      <div className="sidebar-section-title"><h2>Your library</h2><span className="count">{documents.length} / 8</span></div>
      <button className="upload-button" disabled={uploading || !workspace || documents.length >= 8} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle className="spin" size={17}/> : <Plus size={18}/>} {uploading ? 'Uploading documents…' : 'Upload documents'}</button>
      <input ref={fileInput} type="file" multiple accept=".pdf,.txt" className="visually-hidden" aria-label="Choose documents" onChange={event => uploadFiles(event.target.files)}/>
      <div className="sample-controls"><button className="sample-button" disabled={!workspace || uploading || documents.length > 5 || documents.some(doc => doc.synthetic)} onClick={loadSamples}>Load sample documents</button><small>3 synthetic demos · not published research</small><small>PDF or TXT · 10 MB each · 8 documents maximum</small></div>
      <div className="search-field"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a document…" aria-label="Find a document"/></div>
      <div className={`document-list ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (workspace) uploadFiles(event.dataTransfer.files); }}>
        {!workspace ? <div className="library-empty"><LoaderCircle className="spin"/><p>Connecting to workspace…</p></div> : documents.length === 0 ? <div className="library-empty"><span className="library-empty-icon"><Files size={27}/></span><h3>A home for your sources</h3><p>Drop documents here to start<br/>building your research library.</p><span className="file-types">PDF or TXT · up to 10 MB each</span></div> : filtered.length === 0 ? <p className="no-matches">No matching documents.</p> : filtered.map(doc => <div className={`document-item ${source?.id === doc.id && drawer ? 'selected' : ''}`} key={doc.id}>
          <button className="document-open" onClick={event => openSource(doc, event)}><span className="file-icon"><FileText size={19}/></span><span className="document-info"><strong title={doc.name}>{doc.name}</strong><small>{doc.type.toUpperCase()} <span>·</span> {sizeLabel(doc.size)}{doc.type === 'pdf' && doc.pageCount != null && ` · ${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}`}{doc.type === 'txt' && doc.paragraphCount != null && ` · ${doc.paragraphCount} paragraphs`}</small>{doc.synthetic && <span className="synthetic-badge">Synthetic demo</span>}<span className={`status ${doc.status}`}>{doc.status === 'processing' ? <LoaderCircle size={11} className="spin"/> : doc.status === 'ready' ? <Check size={11}/> : <AlertCircle size={11}/>} {doc.status === 'ready' ? 'Ready to read' : doc.status === 'processing' ? 'Reading document' : 'Needs attention'}</span></span></button>
          <button className="delete-button icon-button" title={`Remove ${doc.name}`} aria-label={`Remove ${doc.name}`} disabled={doc.status === 'processing' || deleting === doc.id} onClick={() => removeDocument(doc)}>{deleting === doc.id ? <LoaderCircle size={14} className="spin"/> : <Trash2 size={14}/>}</button>
        </div>)}
      </div>
      <div className="sidebar-bottom"><div className="privacy-card"><ShieldCheck size={19}/><div>Local by design<p>Your documents stay on this device.</p></div></div><div className="sidebar-footer"><span className="avatar">RL</span><span>Personal workspace<small>ResearchLens prototype</small></span><span className="version">v0.1</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span className="breadcrumb">Workspace</span><ChevronRight size={14}/><strong>Research desk</strong></div><div className="topbar-right"><span className="local-pill"><span className="local-dot"/>Local workspace</span><button className={`icon-button ${drawer ? 'active' : ''}`} title="Open evidence viewer" aria-label="Open evidence viewer" onClick={event => { sourceTrigger.current = event.currentTarget; setDrawer(!drawer); }}><BookOpen size={19}/></button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span/> YOUR RESEARCH, CONNECTED</div><h1>From sources to understanding.</h1><p>Ask better questions. Compare perspectives. Follow the evidence.</p></div><span className="workspace-label"><FlaskConical size={15}/> Research desk</span></div>
        {error && <div className="alert error" role="alert"><AlertCircle size={18}/><span>{error}</span>{!workspace && <button onClick={() => { setError(''); refresh().catch(() => setError('Cannot connect to your workspace. Please check the local server.')); }}>Retry</button>}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
        <form className="question-card" onSubmit={analyze}><label htmlFor="question"><Sparkles size={18}/> What would you like to explore?</label><textarea id="question" value={question} maxLength={4000} disabled={!workspace} onChange={event => { retrievalRequest.current++; setQuestion(event.target.value); setResults(null); }} placeholder="Ask a research question about your documents…" rows={3}/><div className="question-footer"><span><span className={`small-dot ${ready ? 'available' : ''}`}/>{ready ? `${ready} ${ready === 1 ? 'source' : 'sources'} ready to read` : 'Add documents to get started'}{saveState && <small className="save-state">{saveState}</small>}</span><div className="question-actions"><button type="button" className="secondary-button" disabled={!question.trim() || !ready || searching || analyzing || uploading || processing} onClick={findPassages}>{searching ? <LoaderCircle size={15} className="spin"/> : <Search size={15}/>} {searching ? 'Finding…' : 'Find passages'}</button><button className="primary-button" disabled={!question.trim() || !ready || analyzing || searching || uploading || processing}>{analyzing ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>} {analyzing ? 'Checking…' : 'Analyze'}<ArrowRight size={16}/></button></div></div></form>
        <div className="prototype-note"><CircleHelp size={14}/><span>Find passages searches your source text. AI analysis is not connected; search matches are not research findings.</span></div>
        {notice && <div className="alert info" role="status"><CircleHelp size={18}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={16}/></button></div>}
        <div className="research-section"><div className="tabs" role="tablist" aria-label="Research results">{tabs.map(({ name, icon: Icon }) => <button key={name} id={`tab-${name.replaceAll(' ', '-')}`} role="tab" aria-selected={tab === name} aria-controls="research-panel" tabIndex={tab === name ? 0 : -1} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = tabs.findIndex(item => item.name === tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; setTab(tabs[next].name); document.getElementById(`tab-${tabs[next].name.replaceAll(' ', '-')}`)?.focus(); } }} onClick={() => setTab(name)}><Icon size={16}/>{name}{name === 'Activity' && !!workspace?.activity.length && <span className="tab-count">{workspace.activity.length}</span>}</button>)}</div>
          <section className="results-panel" id="research-panel" role="tabpanel" aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}>
            {tab === 'Overview' && results && results.query === question ? <div className="retrieval-results"><div className="section-heading"><h2>Matching passages</h2><span>{results.passages.length} matches</span></div><p className="retrieval-note">Ranked by matching words, with a balance of relevant sources. Scores indicate text relevance, not evidence quality.</p>{results.passages.length === 0 ? <div className="no-results"><Search size={26}/><h3>No matching passages</h3><p>Try specific terms used in your sources. No answer has been inferred.</p></div> : results.passages.map(passage => <button className="result-card" key={passage.id} onClick={event => openSource({ id: passage.documentId }, event, passage.id)}><div className="result-title"><strong>{passage.filename}</strong><span className="page-badge">{reference(passage)}</span></div>{passage.synthetic && <span className="synthetic-badge">Synthetic demo · not published research</span>}<p>{passage.text}</p><div className="result-footer"><span>Match {passage.rank} · Relevance {passage.score.toFixed(2)}</span><span>Read passage <ArrowRight size={13}/></span></div></button>)}</div> : tab === 'Activity' && workspace?.activity.length ? <div className="activity-panel"><div className="section-heading"><h2>Workspace activity</h2><span>Saved on this device</span></div>{workspace.activity.map(item => <div className="activity-row" key={item.id}><span className="activity-icon"><FileText size={16}/></span><div><p>{item.message}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></div><span className="activity-line"/></div>)}</div> : <EmptyResults tab={tab} hasDocuments={documents.length > 0} onUpload={() => fileInput.current?.click()} disabled={!workspace || uploading}/>}
          </section>
        </div>
        <div className="trust-footer"><span><ShieldCheck size={14}/> Grounded in your sources</span><span><BookOpen size={14}/> Traceable evidence</span><span><GitCompareArrows size={14}/> Multiple perspectives</span></div>
      </main>
      <footer className="main-footer"><span>A clearer view of your research.</span><span>Built for curious minds <span className="footer-star">✧</span></span></footer>
    </div>
    {drawer && <><div className="drawer-backdrop" onClick={() => setDrawer(false)}/><aside ref={drawerRef} className="evidence-drawer" role="dialog" aria-modal="true" aria-label="Source evidence"><div className="drawer-header"><div><BookOpen size={18}/><h2>Source evidence</h2></div><button ref={closeButton} className="icon-button" aria-label="Close evidence viewer" onClick={() => setDrawer(false)}><PanelRightClose size={19}/></button></div>
      {sourceLoading ? <div className="drawer-empty" role="status"><LoaderCircle className="spin"/><h3>Opening source…</h3></div> : sourceError ? <div className="drawer-empty" role="alert"><AlertCircle/><p>{sourceError}</p></div> : !source ? <div className="drawer-empty"><span className="empty-symbol"><BookOpen size={28}/></span><h3>See it in the source</h3><p>Select a document or a matching passage to read its exact extracted text and reference.</p></div> : <>
        <div className="source-meta"><span className="source-badge"><FileText size={12}/> {source.synthetic ? 'SYNTHETIC DEMO SOURCE' : 'ORIGINAL SOURCE'}</span><h3>{source.name}</h3><p>{source.type.toUpperCase()} · {sizeLabel(source.size)}{source.type === 'pdf' && source.pageCount != null ? ' · ' + source.pageCount + ' pages' : source.paragraphCount != null ? ' · ' + source.paragraphCount + ' paragraphs' : ''}</p>{source.synthetic && <p className="synthetic-notice">Fictional demo content. Not published research.</p>}<a className="download-link" href={'/api/documents/' + source.id + '/file'} download><ArrowDownToLine size={14}/>Download original</a></div>
        {source.status === 'error' ? <div className="source-error" role="alert"><AlertCircle size={20}/><p>{source.error}</p></div> : source.status === 'processing' ? <div className="drawer-empty"><LoaderCircle className="spin"/><p>This document is being read. Passages will appear when processing finishes.</p></div> : <>
          <div className="passage-heading"><span>Original passage</span><span className="page-badge">{reference(source.passages[page])}</span></div>
          <div className="passage"><p>{source.passages[page]?.text || 'No readable passages.'}</p></div>
          <div className="page-controls"><button className="icon-button" aria-label="Previous passage" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={18}/></button><span>Passage {page + 1} of {source.passages.length}</span><button className="icon-button" aria-label="Next passage" disabled={page >= source.passages.length - 1} onClick={() => setPage(page + 1)}><ChevronRight size={18}/></button></div>
          <p className="source-footnote">{source.type === 'pdf' ? 'Page numbers match the original PDF. Extracted layout may differ.' : 'Paragraph references follow blank-line-separated paragraphs in the original TXT file. TXT files have no page numbers.'} Passages overlap to preserve context. This is source text, not an analysis finding.</p>
        </>}
      </>}
    </aside></>}
  </div>;
}

function EmptyResults({ tab, hasDocuments, onUpload, disabled }) {
  const copy = {
    Overview: { icon: Sparkles, title: hasDocuments ? 'Your sources are the starting point.' : 'Your next insight starts with a source.', text: hasDocuments ? 'Read your documents, shape your question, and prepare your research. Evidence-backed answers will appear here once analysis is connected.' : 'Bring your documents together in one place. Then explore questions, connect ideas, and trace every finding back to its source.' },
    Comparison: { icon: GitCompareArrows, title: 'Different sources. A fuller picture.', text: 'Once analysis is connected, compare where your sources agree, where they differ, and which perspectives need a closer look.' },
    'Evidence Gaps': { icon: ScanText, title: 'Know what the evidence leaves open.', text: 'Unanswered questions and claims that need more support will appear here once analysis is connected. No gaps have been assessed yet.' },
    Activity: { icon: Clock3, title: 'A fresh start for your research.', text: 'Your uploads and document updates will appear here as you build your library.' },
  }[tab];
  const Icon = copy.icon;
  return <div className="empty-results"><div className="empty-illustration"><span className="orbit orbit-one"/><span className="orbit orbit-two"/><span className="floating-file left"><FileText size={22}/><i/><i/></span><span className="empty-symbol"><Icon size={30}/></span><span className="floating-file right"><ScanText size={22}/><i/><i/></span><span className="tiny-spark">✧</span></div><span className="empty-kicker">{tab === 'Overview' ? 'A LITTLE CONTEXT GOES A LONG WAY' : 'ROOM FOR DISCOVERY'}</span><h2>{copy.title}</h2><p>{copy.text}</p>{!hasDocuments && <button className="secondary-button" disabled={disabled} onClick={onUpload}><Upload size={16}/>Upload your first document<ArrowRight size={15}/></button>}{tab === 'Overview' && <div className="steps"><div><span>01</span><strong>Add your sources</strong><small>Keep your research together</small></div><div><span>02</span><strong>Ask a question</strong><small>Give your exploration a direction</small></div><div><span>03</span><strong>Follow the evidence</strong><small>Analysis coming next</small></div></div>}</div>;
}
