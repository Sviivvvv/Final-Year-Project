import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, PlusCircle, CheckCircle2, ShieldAlert, ScanSearch, Check, Loader2, Circle,
  MinusCircle, XCircle, FileText, Play, RefreshCw, Lock, Eye, ClipboardCopy,
} from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import {
  EMPTY_FIELDS, EXAMPLES, MAX_ATTEMPTS, PASS_THRESHOLD, DIMENSIONS, SECTIONS, SECTION_NAMES, refId, formatDateTime, shortIssueTag, copyText, reportAsText,
} from '../lib/format.js';
import { IncompleteMessage, ReviewNote, StepDot } from '../components/Messages.jsx';
import ResultPanel, { groupRecs } from '../components/ResultPanel.jsx';

const MAX_CHARS = 2000;

const fieldsOf = (a) => ({
  observed_behavior:  a?.observed_behavior ?? '',
  expected_behavior:  a?.expected_behavior ?? '',
  steps_to_reproduce: a?.steps_to_reproduce ?? '',
});

/* ------------------------------------------------------------------------ */
/* The pipeline as a list of checks (like CI), not a conversation.          */
/* ------------------------------------------------------------------------ */
const CHECKS = [
  { key: 'structure', title: 'Structure check',   sub: 'Finds the three required parts in your text' },
  { key: 'score',     title: 'Quality scoring',   sub: 'Marks it out of 100 on four areas' },
  { key: 'fixes',     title: 'Fix suggestions',   sub: 'Points at the exact sentences to improve' },
];

function checkStates(mode, attempt, runStep) {
  if (mode === 'running') return CHECKS.map((_, i) => (i < runStep ? 'ok' : i === runStep ? 'run' : 'wait'));
  if (!attempt) return CHECKS.map(() => 'idle');
  if (attempt.status === 'rejected_incomplete') return ['fail', 'skip', 'skip'];
  return ['ok', attempt.passed ? 'ok' : 'fail', 'ok'];
}

function checkDetail(key, state, attempt) {
  if (!attempt || state === 'run' || state === 'wait' || state === 'idle') return null;
  if (key === 'structure') {
    if (state === 'fail') return `Missing: ${(attempt.missing_sections ?? []).map(c => SECTION_NAMES[c] ?? c).join(', ')}`;
    return 'All three parts found';
  }
  if (key === 'score') {
    if (state === 'skip') return 'Skipped until the structure check passes';
    return `${attempt.total_score ?? 0} / 100 (pass mark ${PASS_THRESHOLD})`;
  }
  if (state === 'skip') return 'Skipped';
  const n = attempt.recommendations?.length ?? 0;
  return n ? `${n} suggestion${n === 1 ? '' : 's'}` : 'Nothing to fix';
}

const STATE_ICON = {
  ok:   <CheckCircle2 size={17} aria-hidden="true" />,
  fail: <XCircle size={17} aria-hidden="true" />,
  run:  <Loader2 size={17} className="spin" aria-hidden="true" />,
  wait: <Circle size={17} aria-hidden="true" />,
  idle: <Circle size={17} aria-hidden="true" />,
  skip: <MinusCircle size={17} aria-hidden="true" />,
};

export function Checks({ mode, attempt }) {
  const [runStep, setRunStep] = useState(0);
  useEffect(() => {
    if (mode !== 'running') { setRunStep(0); return undefined; }
    const t = setInterval(() => setRunStep(s => Math.min(s + 1, CHECKS.length - 1)), 1800);
    return () => clearInterval(t);
  }, [mode]);
  const states = checkStates(mode, attempt, runStep);
  return (
    <ol className="checks" aria-live="polite">
      {CHECKS.map((c, i) => {
        const st = states[i];
        const detail = checkDetail(c.key, st, attempt);
        return (
          <li key={c.key} className={`check st-${st}`}>
            <span className="check-ic">{STATE_ICON[st]}</span>
            <div className="grow">
              <b>{c.title}</b>
              <small>{detail ?? c.sub}</small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------------ */
/* Revision stepper: one box per try, plus the draft you are working on.     */
/* ------------------------------------------------------------------------ */
export function Revisions({ attempts, draftOpen, viewIdx, onPick }) {
  const items = attempts.map((a, i) => {
    const incomplete = a.status === 'rejected_incomplete';
    const tone = incomplete ? 'bad' : a.passed ? 'good' : 'bad';
    return { i, label: `Rev ${a.attempt_number}`, sub: incomplete ? 'Incomplete' : `${a.total_score ?? 0}/100`, tone };
  });
  if (draftOpen) items.push({ i: attempts.length, label: `Rev ${attempts.length + 1}`, sub: 'Draft', tone: 'draft' });
  const empty = Math.max(0, MAX_ATTEMPTS - items.length);
  return (
    <div className="revs" role="tablist" aria-label="Revisions">
      {items.map((it, k) => (
        <span key={it.i} className="rev-wrap">
          {k > 0 && <span className="rev-line" aria-hidden="true" />}
          <button role="tab" aria-selected={viewIdx === it.i} className={`rev tone-${it.tone} ${viewIdx === it.i ? 'on' : ''}`} onClick={() => onPick(it.i)}>
            <b>{it.label}</b><small>{it.sub}</small>
          </button>
        </span>
      ))}
      {Array.from({ length: empty }, (_, k) => (
        <span key={`e${k}`} className="rev-wrap">
          {(items.length + k) > 0 && <span className="rev-line" aria-hidden="true" />}
          <span className="rev rev-empty"><b>Rev {items.length + k + 1}</b><small>Not used</small></span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The report form, as a document with three labelled parts.                */
/* ------------------------------------------------------------------------ */
export function ReportForm({ fields, setFields, readOnly, missing, autoFocus, notes = null }) {
  return (
    <div className="doc">
      {SECTIONS.map((s, i) => {
        const isMissing = missing.includes(s.code);
        const val = fields[s.key];
        const mine = notes?.[s.code] ?? [];
        return (
          <section className={`doc-part ${isMissing ? 'is-missing' : ''} ${mine.length ? 'has-notes' : ''}`} key={s.key} id={`part-${s.key}`}>
            <header className="doc-label">
              <StepDot s={s} />
              <b>{s.label}</b>
              <span className={`code tag-${s.code}`}>{s.code}</span>
              {isMissing && <span className="chip chip-bad">Not found</span>}
              {mine.length > 0 && <span className="chip chip-warn">{mine.length} to fix</span>}
              <span className="grow" />
              {!readOnly && <span className="count">{val.length} / {MAX_CHARS}</span>}
            </header>
            {readOnly
              ? <div className="doc-text">{val || <span className="muted">Empty</span>}</div>
              : (
                <textarea
                  id={`field-${s.key}`}
                  className="doc-input" rows={s.rows + 1} value={val} placeholder={s.placeholder}
                  autoFocus={autoFocus && i === 0}
                  aria-label={s.label}
                  onChange={e => { const v = e.target.value.slice(0, MAX_CHARS); setFields(prev => ({ ...prev, [s.key]: v })); }}
                />
              )}
            {!readOnly && !mine.length && <p className="doc-hint">{s.hint}</p>}
            {mine.length > 0 && (
              <ul className="part-notes" aria-label={`What to fix in ${s.label}`}>
                {mine.map(r => (
                  <li key={r.n}>
                    <b>{shortIssueTag(r.issue)}:</b> {r.suggested_fix}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Rubric() {
  return (
    <div className="rubric">
      <b>How reports are marked</b>
      <ul>
        {DIMENSIONS.map(d => (
          <li key={d.key}><span>{d.label}</span><span className="muted">{d.max} pts</span></li>
        ))}
      </ul>
      <p className="muted">Pass mark {PASS_THRESHOLD} / 100. You get {MAX_ATTEMPTS} revisions; after that a manager reviews it.</p>
    </div>
  );
}

/**
 * QA workspace. The draft is edited on the left; the quality inspection for
 * the latest (or a chosen earlier) revision stays visible on the right, so the
 * reporter fixes the text while reading the findings.
 */
export default function Workbench({ threadId }) {
  const { api, navigate, refreshHistory, toast } = useApp();

  const [thread, setThread]   = useState(null);
  const [fields, setFields]   = useState(EMPTY_FIELDS);
  const [running, setRunning] = useState(false);
  const [viewIdx, setViewIdx] = useState(null);       // null = latest / draft
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [notFound, setNotFound] = useState(false);

  const loadThread = useCallback(async (id) => {
    const res = await api(`/reports/threads/${id}`);
    if (res.status === 200) { setThread(res.data); setNotFound(false); return res.data; }
    setNotFound(true); setThread(null); return null;
  }, [api]);

  useEffect(() => {
    setError(null); setViewIdx(null);
    if (!threadId) { setThread(null); setNotFound(false); setFields(EMPTY_FIELDS); return undefined; }
    if (thread?.thread_id === threadId) return undefined;   // just created here
    let cancelled = false;
    setLoading(true);
    loadThread(threadId)
      .then(d => { if (!cancelled && d) setFields(fieldsOf(d.attempts[d.attempts.length - 1])); })
      .catch(() => { if (!cancelled) setError('Could not load this report. Is the backend running?'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, loadThread]);

  const attempts = thread?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const outcome = thread?.outcome;
  const finished = outcome === 'passed' || outcome === 'escalated';
  const draftOpen = !finished;
  const latestIdx = draftOpen ? attempts.length : attempts.length - 1;
  const idx = viewIdx ?? latestIdx;
  const viewingDraft = draftOpen && idx === attempts.length;
  const shown = viewingDraft ? null : attempts[idx];
  // While drafting, the inspector shows the most recent result next to the editor.
  const inspected = viewingDraft ? last : shown;
  const missing = inspected?.status === 'rejected_incomplete' ? (inspected.missing_sections ?? []) : [];
  const sideRef = useRef(null);
  const inspectedId = running ? 'running' : inspected?.report_id;
  useEffect(() => { sideRef.current?.scrollTo({ top: 0 }); }, [inspectedId]);
  const failedScore = inspected && inspected.status !== 'rejected_incomplete' && !inspected.passed;
  const notes = failedScore ? groupRecs(inspected) : null;
  const goTo = (key) => {
    if (!viewingDraft && draftOpen) setViewIdx(null);
    requestAnimationFrame(() => {
      document.getElementById(`part-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.getElementById(`field-${key}`)?.focus({ preventScroll: true });
    });
  };
  const ready = SECTIONS.every(s => fields[s.key].trim().length > 0);
  const changed = !last || SECTIONS.some(s => fields[s.key] !== (last[s.key] ?? ''));

  const submit = async () => {
    if (!ready || running) return;
    const sent = { ...fields };
    setError(null); setRunning(true); setViewIdx(null);
    try {
      const res = await api('/reports', { method: 'POST', body: { ...sent, ...(threadId ? { thread_id: threadId } : {}) } });
      const data = res.data ?? {};
      if (data.thread_id && (res.status === 200 || data.status === 'rejected_incomplete')) {
        const full = await loadThread(data.thread_id);
        if (full) {
          setFields(sent);
          if (!threadId) navigate(`t/${data.thread_id}`);
          refreshHistory();
        }
      } else {
        if (res.status === 409 && threadId) await loadThread(threadId);
        setError(data.detail ? `${data.error} ${data.detail}` : (data.error ?? `Something went wrong (HTTP ${res.status}).`));
      }
    } catch {
      setError('Could not reach the server. Make sure the backend is running.');
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  if (notFound) {
    return (
      <div className="scroll"><div className="col"><div className="empty">
        <AlertTriangle size={34} aria-hidden="true" />
        <p>That report could not be found.</p>
        <button className="btn btn-primary" onClick={() => navigate('new')}><PlusCircle size={16} aria-hidden="true" />New report</button>
      </div></div></div>
    );
  }

  const isNew = !threadId;
  const nextRev = attempts.length + 1;

  return (
    <div className="bench" onKeyDown={onKeyDown}>
      {/* ---------------- left: the report ---------------- */}
      <div className="bench-main">
        <div className="bench-head">
          <div className="grow">
            <div className="ref-line">
              <FileText size={15} aria-hidden="true" />
              <span className="mono">{isNew ? 'New draft' : refId(threadId)}</span>
              {outcome === 'passed' && <span className="chip chip-good">Passed</span>}
              {outcome === 'escalated' && <span className="chip chip-bad">With manager</span>}
              {!finished && !isNew && <span className="chip chip-quiet">In revision</span>}
            </div>
            <h2>{isNew ? 'Write a bug report' : (attempts[0]?.observed_behavior?.slice(0, 80) || 'Bug report')}</h2>
          </div>
          {isNew && (
            <div className="samples">
              <span className="muted">Load a sample:</span>
              {EXAMPLES.map(ex => (
                <button key={ex.id} className="btn btn-sm" onClick={() => setFields(ex.fields)}>{ex.label.replace(/^Try an? /, '')}</button>
              ))}
            </div>
          )}
        </div>

        {!isNew && <Revisions attempts={attempts} draftOpen={draftOpen} viewIdx={idx} onPick={setViewIdx} />}

        {error && <div className="alert" style={{ margin: '0 0 14px' }} role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}

        {loading && !thread
          ? <div className="skeleton" style={{ height: 380 }} />
          : (
            <>
              {!viewingDraft && shown && (
                <div className="viewing-note">
                  <Eye size={15} aria-hidden="true" />
                  {finished && idx === attempts.length - 1 ? 'Final revision' : `Viewing revision ${shown.attempt_number}`}
                  <span className="muted"> · sent {formatDateTime(shown.submitted_at)}</span>
                  {draftOpen && <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setViewIdx(null)}>Back to draft</button>}
                </div>
              )}
              <ReportForm
                fields={viewingDraft || isNew ? fields : fieldsOf(shown)}
                setFields={setFields}
                readOnly={!(viewingDraft || isNew) || running}
                missing={viewingDraft ? missing : (shown?.missing_sections ?? [])}
                autoFocus={isNew && window.innerWidth > 980}
                notes={notes}
              />

              {(viewingDraft || isNew) && (
                <div className="bench-actions">
                  <span className="note"><Lock size={13} aria-hidden="true" />Text is only used to score the report. Ctrl + Enter runs the check.</span>
                  <span className="grow" />
                  {!isNew && <span className="muted" style={{ fontSize: 13 }}>Revision {nextRev} of {MAX_ATTEMPTS}</span>}
                  <button className="btn btn-primary" onClick={submit} disabled={!ready || running || (!isNew && !changed)}
                    title={!isNew && !changed ? 'Change something first' : undefined}>
                    {running
                      ? <><Loader2 size={16} className="spin" aria-hidden="true" />Checking...</>
                      : isNew ? <><Play size={16} aria-hidden="true" />Run quality check</> : <><RefreshCw size={16} aria-hidden="true" />Re-check revision {nextRev}</>}
                  </button>
                </div>
              )}

              {finished && (
                <div className={`outcome-bar ${outcome === 'passed' ? 'tone-good' : 'tone-bad'}`}>
                  {outcome === 'passed' ? <CheckCircle2 size={20} aria-hidden="true" /> : <ShieldAlert size={20} aria-hidden="true" />}
                  <div className="grow">
                    <b>{outcome === 'passed' ? 'Ready for the development team' : 'Handed to a manager'}</b>
                    <p className="muted">{outcome === 'passed'
                      ? `Passed on revision ${last?.attempt_number}.`
                      : `All ${MAX_ATTEMPTS} revisions were used.${thread?.review ? '' : ' A manager will review it and leave a note.'}`}</p>
                  </div>
                  {outcome === 'passed' && (
                    <button className="btn btn-primary" onClick={async () => toast((await copyText(reportAsText(last))) ? 'Report copied' : 'Could not copy')}>
                      <ClipboardCopy size={16} aria-hidden="true" />Copy report
                    </button>
                  )}
                  <button className="btn" onClick={() => navigate('new')}><PlusCircle size={16} aria-hidden="true" />New report</button>
                </div>
              )}
              {outcome === 'escalated' && thread?.review && <div style={{ marginTop: 14 }}><ReviewNote review={thread.review} /></div>}
            </>
          )}
      </div>

      {/* ---------------- right: the inspection ---------------- */}
      <aside className="bench-side" aria-label="Quality inspection" ref={sideRef}>
        <div className="side-title">
          <ScanSearch size={17} aria-hidden="true" />
          <b>Quality inspection</b>
          {inspected && !running && <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>Rev {inspected.attempt_number}</span>}
        </div>

        <Checks mode={running ? 'running' : 'done'} attempt={running ? null : inspected} />

        {!running && !inspected && <Rubric />}

        {!running && inspected && (
          <div className="inspect-result">
            {viewingDraft && changed && (
              <p className="stale"><AlertTriangle size={14} aria-hidden="true" />Your draft has changed since this check. Re-check to update the score.</p>
            )}
            {inspected.status === 'rejected_incomplete'
              ? <IncompleteMessage attempt={inspected} />
              : <ResultPanel attempt={inspected} canRate={inspected === last} editable={draftOpen} onGoTo={goTo} />}
          </div>
        )}
      </aside>
    </div>
  );
}
