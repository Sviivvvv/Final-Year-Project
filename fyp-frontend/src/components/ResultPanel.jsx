import { useState } from 'react';
import {
  CheckCircle2, XCircle, ThumbsUp, ThumbsDown, ClipboardCopy, Check, ArrowRight, ChevronDown, AlertTriangle,
} from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import DimensionBars from './DimensionBars.jsx';
import ScoreRing from './ScoreRing.jsx';
import { PointsLost, Why, Pips, StepDot } from './Messages.jsx';
import {
  SECTIONS, MAX_ATTEMPTS, PASS_THRESHOLD, shortIssueTag, copyText, reportAsText, tone,
} from '../lib/format.js';

const CODE_RE = /^\s*(OB|EB|S2R)\s*:\s*/i;

/** Text of the quoted sentence without the "OB:" style prefix the scorer adds. */
export const quoteText = (ref) => String(ref ?? '').replace(CODE_RE, '').trim();

/**
 * Which report part a recommendation is about: the scorer's "OB:/EB:/S2R:"
 * prefix if present, otherwise the part that contains the quoted sentence.
 */
export function partOf(rec, attempt) {
  const m = String(rec.sentence_reference ?? '').match(CODE_RE);
  if (m) return m[1].toUpperCase();
  const q = quoteText(rec.sentence_reference).slice(0, 40);
  if (q.length >= 6) {
    const hit = SECTIONS.find(s => String(attempt?.[s.key] ?? '').includes(q));
    if (hit) return hit.code;
  }
  return 'GEN';
}

/** Recommendations bucketed by report part, in form order. */
export function groupRecs(attempt) {
  const out = { OB: [], EB: [], S2R: [], GEN: [] };
  (attempt?.recommendations ?? []).forEach((r, i) => out[partOf(r, attempt)].push({ ...r, n: i + 1 }));
  return out;
}

function Rate({ attempt }) {
  const { api, toast } = useApp();
  const [vote, setVote] = useState(attempt.user_feedback?.helpful ?? null);
  const rate = async (helpful) => {
    setVote(helpful);
    const res = await api(`/reports/${attempt.report_id}/feedback`, { method: 'POST', body: { helpful } }).catch(() => null);
    toast(res?.status === 200 ? 'Thanks for the feedback' : 'Could not save your rating');
  };
  return (
    <div className="rp-rate">
      <span className="muted">Was this feedback useful?</span>
      <button className={`btn btn-sm ${vote === true ? 'btn-primary' : ''}`} onClick={() => rate(true)} aria-pressed={vote === true} aria-label="Yes, useful"><ThumbsUp size={14} aria-hidden="true" /></button>
      <button className={`btn btn-sm ${vote === false ? 'btn-primary' : ''}`} onClick={() => rate(false)} aria-pressed={vote === false} aria-label="No, not useful"><ThumbsDown size={14} aria-hidden="true" /></button>
    </div>
  );
}

function Fold({ title, count, children, open = false }) {
  return (
    <details className="rp-fold" open={open}>
      <summary><span className="grow">{title}{count > 0 && <span className="rp-count">{count}</span>}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <div className="rp-fold-body">{children}</div>
    </details>
  );
}

function FixList({ attempt, onGoTo, editable }) {
  const groups = groupRecs(attempt);
  const parts = [...SECTIONS.map(s => ({ code: s.code, s })), { code: 'GEN', s: null }].filter(p => groups[p.code].length);
  if (!parts.length) return <p className="muted" style={{ fontSize: 14 }}>No specific sentences were flagged. See the score breakdown below.</p>;
  return (
    <div className="fixlist">
      {parts.map(({ code, s }) => (
        <div className="fixgroup" key={code}>
          <div className="fixgroup-head">
            {s ? <StepDot s={s} /> : null}
            <b className="grow">{s ? s.label : 'Whole report'}</b>
            {s && editable && (
              <button className="btn btn-sm" onClick={() => onGoTo(s.key)}>Edit<ArrowRight size={14} aria-hidden="true" /></button>
            )}
          </div>
          {groups[code].map(r => (
            <div className="fix" key={r.n}>
              <div className="fix-tag">{shortIssueTag(r.issue)}</div>
              {quoteText(r.sentence_reference) && <div className="fix-quote">"{quoteText(r.sentence_reference)}"</div>}
              <div className="fix-do">{r.suggested_fix}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Result of one quality check, laid out for the person who has to act on it.
 * Failed: what to fix first (grouped by report part, with a jump to that part),
 * then the score breakdown. Passed: copy the finished report first.
 */
export default function ResultPanel({ attempt, onGoTo, editable = false, canRate = false }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const passed = attempt.passed === true;
  const score = Number(attempt.total_score) || 0;
  const t = tone(score);
  const recs = attempt.recommendations ?? [];
  const lost = attempt.deductions_applied ?? [];
  const left = Math.max(0, MAX_ATTEMPTS - attempt.attempt_number);

  const copyReport = async () => {
    const ok = await copyText(reportAsText(attempt));
    toast(ok ? 'Report copied' : 'Could not copy');
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  return (
    <div className="rp">
      <div className={`rp-head tone-${t}`}>
        <ScoreRing score={score} size={150} />
        <div className="rp-head-text">
          <div className="rp-verdict">
            {passed ? <CheckCircle2 size={17} aria-hidden="true" /> : <XCircle size={17} aria-hidden="true" />}
            {attempt.escalated ? 'Sent to a manager' : passed ? (score >= 80 ? 'Ready to send' : 'Passed, room to improve') : 'Not ready yet'}
          </div>
          <p>{passed
            ? 'This report can go to the development team.'
            : attempt.escalated
              ? `Below the pass mark of ${PASS_THRESHOLD} with no revisions left.`
              : `Needs ${PASS_THRESHOLD - score} more points to pass. ${left} revision${left === 1 ? '' : 's'} left.`}</p>
        </div>
        <Pips attempt={attempt.attempt_number} passed={passed} escalated={attempt.escalated} withText={false} />
      </div>

      {passed && (
        <div className="rp-sec">
          <button className="btn btn-primary btn-block" onClick={copyReport}>
            {copied ? <><Check size={16} aria-hidden="true" />Copied</> : <><ClipboardCopy size={16} aria-hidden="true" />Copy report</>}
          </button>
          <p className="rp-note">Copies Observed Behaviour, Expected Behaviour and Steps to Reproduce, ready to paste into your tracker.</p>
        </div>
      )}

      {!passed && (
        <div className="rp-sec">
          <h4>What to fix{recs.length > 0 && <span className="rp-count">{recs.length}</span>}</h4>
          {editable && <p className="rp-note" style={{ marginTop: -4, marginBottom: 10 }}>The same notes appear under each part of your report on the left.</p>}
          <FixList attempt={attempt} onGoTo={onGoTo} editable={editable} />
        </div>
      )}

      <div className="rp-sec">
        <h4>Score breakdown</h4>
        <DimensionBars scores={attempt.dimension_scores} />
      </div>

      <div className="rp-sec rp-folds">
        {passed && recs.length > 0 && (
          <Fold title="Optional improvements" count={recs.length}><FixList attempt={attempt} editable={false} /></Fold>
        )}
        <Fold title="Where points were lost" count={lost.length}><PointsLost items={lost} /></Fold>
        <Fold title="Scorer's explanation"><Why attempt={attempt} /></Fold>
        {attempt.c2_parsed_ok === false && (
          <div className="alert alert-info" style={{ marginTop: 10 }}><AlertTriangle size={16} aria-hidden="true" />
            The scorer's answer was partly unreadable, so some details may be missing.
          </div>
        )}
      </div>

      {canRate && <Rate attempt={attempt} />}
    </div>
  );
}
