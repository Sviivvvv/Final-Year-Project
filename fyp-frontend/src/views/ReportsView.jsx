import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Inbox, Search, ArrowLeft, AlertTriangle, CheckCircle2, Send, Loader2, RefreshCw,
  ChevronRight, PartyPopper, Clock, XCircle, Gavel, Eye, FileText, X,
} from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import { hashQuery } from '../lib/hooks.js';
import {
  MAX_ATTEMPTS, displayName, initials, fmtHours, waitTone, timeAgo, formatDateTime, shortIssueTag, refId, tone,
} from '../lib/format.js';
import { IncompleteMessage } from '../components/Messages.jsx';
import ResultPanel, { groupRecs } from '../components/ResultPanel.jsx';
import { Checks, Revisions, ReportForm } from './Workbench.jsx';

const TABS = [
  { key: 'open',     label: 'Waiting for me', filter: 'escalated_open',     count: 'escalated_open' },
  { key: 'reviewed', label: 'Decided',        filter: 'escalated_reviewed', count: 'escalated_reviewed' },
  { key: 'all',      label: 'All reports',    filter: 'all',                count: 'all' },
];

const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : null);

function StatusChip({ t }) {
  if (t.outcome === 'passed') return <span className="chip chip-good"><CheckCircle2 size={13} aria-hidden="true" />Passed</span>;
  if (t.outcome === 'escalated') {
    if (t.review) return <span className={`chip ${t.review.decision === 'accepted' ? 'chip-good' : 'chip-accent'}`}>{t.review.decision === 'accepted' ? 'Accepted' : 'Sent back'}</span>;
    return <span className="chip chip-bad">Needs a decision</span>;
  }
  return <span className="chip chip-quiet">In revision</span>;
}

function WaitChip({ since }) {
  const h = hoursSince(since);
  if (h === null) return null;
  const cls = { good: 'chip-good', warn: 'chip-warn', bad: 'chip-bad' }[waitTone(h)];
  return <span className={`chip ${cls}`}><Clock size={12} aria-hidden="true" />Waiting {fmtHours(h)}</span>;
}

function StatusIcon({ t }) {
  if (t.outcome === 'passed' || t.review?.decision === 'accepted') return <CheckCircle2 size={17} style={{ color: 'var(--good-ink)' }} aria-hidden="true" />;
  if (t.outcome === 'escalated' && !t.review) return <XCircle size={17} style={{ color: 'var(--bad-ink)' }} aria-hidden="true" />;
  return <Clock size={17} style={{ color: 'var(--ink-3)' }} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Queue: one ticket row per report thread
// ---------------------------------------------------------------------------

function TicketRow({ t, onOpen }) {
  const waiting = t.outcome === 'escalated' && !t.review;
  return (
    <button className={`trow ${waiting ? 'urgent' : ''}`} onClick={onOpen}>
      <StatusIcon t={t} />
      <div className="trow-main">
        <span className="t-ref mono">{refId(t.thread_id)} · rev {t.attempts} of {MAX_ATTEMPTS}</span>
        <span className="trow-title">{t.title || '(no text)'}</span>
      </div>
      <span className="who-chip trow-who"><span className="avatar avatar-xs">{initials(t.user_email ?? '')}</span>{displayName(t.user_email ?? 'unknown')}</span>
      <span className="trow-state">{waiting ? <WaitChip since={t.waiting_since} /> : <StatusChip t={t} />}</span>
      <span className="trow-when muted">{timeAgo(t.updated_at)}</span>
      {typeof t.latest_score === 'number'
        ? <span className={`t-score tone-${tone(t.latest_score)}`}>{t.latest_score}</span>
        : <span className="t-score">-</span>}
      <ChevronRight size={17} className="muted" aria-hidden="true" />
    </button>
  );
}

function QueuePage({ tab }) {
  const { api, navigate, historyVersion } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const current = TABS.find(t => t.key === tab) ?? TABS[0];
  // Filters set by clicking through from Insights: ?tag=Too%20vague or ?user=a@b.com
  const params = hashQuery();
  const tagFilter = params.get('tag') ?? '';
  const userFilter = params.get('user') ?? '';
  const qs = tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : userFilter ? `?user=${encodeURIComponent(userFilter)}` : '';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const extra = `${q ? `&q=${encodeURIComponent(q)}` : ''}${tagFilter ? `&tag=${encodeURIComponent(tagFilter)}` : ''}${userFilter ? `&user=${encodeURIComponent(userFilter)}` : ''}`;
      const res = await api(`/reports/threads?filter=${current.filter}${extra}`);
      if (res.status === 200) setData(res.data); else setError(res.data?.error ?? 'Could not load reports.');
    } catch { setError('Could not reach the server.'); }
    finally { setLoading(false); }
  }, [api, current.filter, q, tagFilter, userFilter]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q, historyVersion]);

  const threads = useMemo(() => {
    const list = data?.threads ?? [];
    // Oldest waiting first, so nothing sits forever.
    return tab === 'open' ? [...list].sort((a, b) => (a.waiting_since ?? '').localeCompare(b.waiting_since ?? '')) : list;
  }, [data, tab]);

  const emptyText = {
    open: ['You are all caught up', 'Nothing is waiting for a decision right now.'],
    reviewed: ['No decisions yet', 'Reports you accept or send back will appear here.'],
    all: ['No reports match', 'Try a different search.'],
  }[current.key];

  return (
    <div className="scroll">
      <div className="col col-wide">
        <div className="page-head">
          <div className="grow">
            <h2>Review queue</h2>
            <p>Reports that failed all {MAX_ATTEMPTS} revisions need your decision. Oldest first.</p>
          </div>
          <button className="btn btn-sm" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} aria-hidden="true" />Refresh</button>
        </div>

        <div className="toolbar">
          <div className="seg" role="group" aria-label="Show">
            {TABS.map(t => (
              <button key={t.key} className={t.key === current.key ? 'on' : ''} aria-pressed={t.key === current.key} onClick={() => navigate(`reports/${t.key}${qs}`)}>
                {t.label}{data && <span className="n">{data.counts[t.count]}</span>}
              </button>
            ))}
          </div>
          <div className="search-box">
            <Search size={15} aria-hidden="true" />
            <input className="input" placeholder="Search by text or person" value={q} onChange={e => setQ(e.target.value)} aria-label="Search reports" />
          </div>
        </div>

        {(tagFilter || userFilter) && (
          <div className="filter-bar">
            <span className="muted">Showing only</span>
            <span className="chip chip-accent">
              {tagFilter ? <>Reports flagged "{tagFilter}"</> : <>Reports by {userFilter === 'unknown' ? 'unknown reporter' : displayName(userFilter)}</>}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => navigate(`reports/${tab}`)}><X size={14} aria-hidden="true" />Clear filter</button>
          </div>
        )}

        {error && <div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}

        <div className="tlist">
          {!data && !error && [0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 58, margin: 8 }} />)}
          {data && threads.length === 0 && (
            <div className="empty">
              {tab === 'open' ? <PartyPopper size={36} aria-hidden="true" /> : <Inbox size={36} aria-hidden="true" />}
              <p><b>{emptyText[0]}</b></p><p>{emptyText[1]}</p>
            </div>
          )}
          {threads.map(t => <TicketRow key={t.thread_id} t={t} onOpen={() => navigate(`reports/${tab}/${t.thread_id}`)} />)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function DecisionPanel({ thread, onSaved }) {
  const { api, toast } = useApp();
  const existing = thread.review;
  const [decision, setDecision] = useState(existing?.decision ?? null);
  const [note, setNote] = useState(existing?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const needsNote = decision === 'needs_rework';

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await api(`/reports/threads/${thread.thread_id}/review`, { method: 'POST', body: { decision, note } });
      if (res.status === 200) { toast('Decision saved'); onSaved(); }
      else setError(res.data?.error ?? 'Could not save.');
    } catch { setError('Could not reach the server.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="decide">
      <div className="side-title" style={{ marginBottom: 8 }}>
        <Gavel size={17} aria-hidden="true" /><b>Your decision</b>
        {!existing && <span className="chip chip-bad" style={{ marginLeft: 'auto' }}>Required</span>}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>The reporter sees your choice and your note.</p>

      <div className="decide-opts">
        <label className={`radio-card ${decision === 'accepted' ? 'on' : ''}`}>
          <input type="radio" name="decision" checked={decision === 'accepted'} onChange={() => setDecision('accepted')} />
          <span><b>Accept</b><small>Good enough for the developers as it is.</small></span>
        </label>
        <label className={`radio-card ${decision === 'needs_rework' ? 'on' : ''}`}>
          <input type="radio" name="decision" checked={decision === 'needs_rework'} onChange={() => setDecision('needs_rework')} />
          <span><b>Send back</b><small>Tell the reporter what to add or change.</small></span>
        </label>
      </div>

      {decision && (
        <>
          <label className="label" htmlFor="review-note" style={{ marginTop: 12 }}>{needsNote ? 'What should they change?' : 'Note (optional)'}</label>
          <textarea id="review-note" className="textarea" rows={3} value={note} onChange={e => setNote(e.target.value.slice(0, 1000))}
            placeholder={needsNote ? 'e.g. Add the exact error text and which browser you used.' : 'e.g. Fine to send. Thanks.'} />
        </>
      )}

      {error && <div className="alert" style={{ marginTop: 10 }} role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}

      <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} onClick={save} disabled={saving || !decision || (needsNote && !note.trim())}>
        {saving ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {existing ? 'Update decision' : 'Save decision'}
      </button>
      {existing && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Decided by {existing.reviewer} on {formatDateTime(existing.reviewed_at)}.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail: same split layout as the QA workbench, read-only, with the decision
// ---------------------------------------------------------------------------

const fieldsOf = (a) => ({
  observed_behavior:  a?.observed_behavior ?? '',
  expected_behavior:  a?.expected_behavior ?? '',
  steps_to_reproduce: a?.steps_to_reproduce ?? '',
});

function DetailPage({ tab, threadId }) {
  const { api, navigate, refreshHistory } = useApp();
  const [thread, setThread] = useState(null);
  const [error, setError] = useState(null);
  const [viewIdx, setViewIdx] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api(`/reports/threads/${threadId}`);
      if (res.status === 200) { setThread(res.data); setError(null); }
      else setError(res.data?.error ?? 'Could not load this report.');
    } catch { setError('Could not reach the server.'); }
  }, [api, threadId]);
  useEffect(() => { setThread(null); setViewIdx(null); load(); }, [load]);

  const attempts = thread?.attempts ?? [];
  const idx = viewIdx ?? attempts.length - 1;
  const shown = attempts[idx];
  const final = attempts[attempts.length - 1];

  const problems = useMemo(() => {
    const counts = new Map();
    for (const a of attempts) for (const r of a.recommendations ?? []) {
      const tag = shortIssueTag(r.issue);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [attempts]);

  const waitingSince = thread?.outcome === 'escalated' && !thread.review ? final?.submitted_at : null;
  const scoredFail = shown && shown.status !== 'rejected_incomplete' && !shown.passed;

  if (error) {
    return <div className="scroll"><div className="col"><div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div></div></div>;
  }
  if (!thread || !final) {
    return <div className="scroll"><div className="col col-wide"><div className="skeleton" style={{ height: 360 }} /></div></div>;
  }

  return (
    <div className="bench">
      <div className="bench-main">
        <button className="btn btn-sm btn-ghost" style={{ marginBottom: 10, marginLeft: -8 }} onClick={() => navigate(`reports/${tab}`)}>
          <ArrowLeft size={15} aria-hidden="true" />Review queue
        </button>

        <div className="bench-head">
          <div className="grow">
            <div className="ref-line">
              <FileText size={15} aria-hidden="true" />
              <span className="mono">{refId(threadId)}</span>
              <StatusChip t={{ outcome: thread.outcome, review: thread.review }} />
              {waitingSince && <WaitChip since={waitingSince} />}
            </div>
            <h2>{(attempts[0]?.observed_behavior ?? '').slice(0, 110) || 'Bug report'}</h2>
            <div className="qmeta" style={{ marginTop: 6 }}>
              <span className="who-chip"><span className="avatar avatar-xs">{initials(thread.user_email ?? '')}</span>{displayName(thread.user_email ?? 'unknown')}</span>
              <span className="muted">{thread.user_email}</span>
            </div>
          </div>
        </div>

        <Revisions attempts={attempts} draftOpen={false} viewIdx={idx} onPick={setViewIdx} />

        {problems.length > 0 && (
          <div className="recurring">
            <span className="muted">Kept coming up:</span>
            {problems.map(([tag, n]) => <span key={tag} className="chip chip-warn">{tag}{n > 1 && ` ×${n}`}</span>)}
          </div>
        )}

        <div className="viewing-note">
          <Eye size={15} aria-hidden="true" />
          {idx === attempts.length - 1 ? `Final revision (${shown.attempt_number} of ${MAX_ATTEMPTS})` : `Revision ${shown.attempt_number}`}
          <span className="muted"> · sent {formatDateTime(shown.submitted_at)}</span>
        </div>
        <ReportForm
          fields={fieldsOf(shown)}
          setFields={() => {}}
          readOnly
          missing={shown.missing_sections ?? []}
          notes={scoredFail ? groupRecs(shown) : null}
        />
      </div>

      <aside className="bench-side" aria-label="Review">
        {thread.outcome === 'escalated'
          ? <DecisionPanel key={thread.review?.reviewed_at ?? 'new'} thread={thread} onSaved={() => { load(); refreshHistory(); }} />
          : (
            <div className="alert alert-info" style={{ marginBottom: 14 }}><CheckCircle2 size={16} aria-hidden="true" />
              {thread.outcome === 'passed' ? 'This report passed on its own. No decision is needed.' : 'The reporter is still revising this report.'}
            </div>
          )}

        <div className="side-title" style={{ marginTop: 18 }}>
          <b>Quality inspection</b>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>Rev {shown.attempt_number}</span>
        </div>
        <Checks mode="done" attempt={shown} />
        {shown.status === 'rejected_incomplete'
          ? <IncompleteMessage attempt={shown} />
          : <ResultPanel key={shown.report_id} attempt={shown} />}
      </aside>
    </div>
  );
}

export default function ReportsView({ tab = 'open', threadId }) {
  return threadId ? <DetailPage tab={tab} threadId={threadId} /> : <QueuePage tab={tab} />;
}
