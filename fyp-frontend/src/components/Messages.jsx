import { useEffect, useState } from 'react';
import {
  Bug, CheckCircle2, XCircle, AlertTriangle, Copy, ThumbsUp, ThumbsDown,
  ClipboardCopy, ShieldAlert, Check, Loader2, ThumbsUp as Good,
} from 'lucide-react';
import ScoreRing from './ScoreRing.jsx';
import DimensionBars from './DimensionBars.jsx';
import { useApp } from '../lib/app-context.js';
import {
  SECTIONS, SECTION_NAMES, DIMENSIONS, MAX_ATTEMPTS, PASS_THRESHOLD, shortIssueTag, formatDateTime,
  copyText, reportAsText, feedbackAsText, verdictFor,
} from '../lib/format.js';

export function BotAvatar() {
  return <div className="bot-avatar" aria-hidden="true"><Bug size={18} /></div>;
}

/** Numbered dot used for the three report parts. */
export function StepDot({ s }) {
  return <span className={`step-dot tag-${s.code}`} aria-hidden="true">{s.n}</span>;
}

/** What the reporter wrote, shown as the "you" message. */
export function UserBubble({ attempt, label }) {
  return (
    <div className="msg msg-user">
      <div className="bubble">
        {SECTIONS.map(s => (
          <div className="sec" key={s.key}>
            <div className="sec-title"><StepDot s={s} />{s.label}</div>
            <div className="sec-body">{attempt[s.key]}</div>
          </div>
        ))}
        <div className="bubble-meta">{label ? `${label} · ` : ''}{formatDateTime(attempt.submitted_at)}</div>
      </div>
    </div>
  );
}

/** Attempt tracker with words: red = used and failed, green = passed, empty = still available. */
export function Pips({ attempt, passed, withText = true, escalated = false }) {
  const left = Math.max(0, MAX_ATTEMPTS - attempt);
  let text;
  if (passed) text = attempt === 1 ? 'Passed first try' : `Passed on try ${attempt}`;
  else if (escalated || left === 0) text = 'No tries left';
  else text = `${left} ${left === 1 ? 'try' : 'tries'} left`;
  return (
    <span className="tries" role="img" aria-label={`Try ${attempt} of ${MAX_ATTEMPTS}. ${text}`}>
      <span className="pips">
        {Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
          let cls = 'pip';
          if (i < attempt - 1) cls += ' used fail';
          else if (i === attempt - 1) cls += passed ? ' used ok' : ' used fail';
          return <span key={i} className={cls} />;
        })}
      </span>
      {withText && <span className="tries-text">{text}</span>}
    </span>
  );
}

const STEPS = [
  'Reading your report',
  'Checking it has all three parts',
  'Scoring how clear and detailed it is',
  'Writing suggestions',
];

/** Assistant "thinking" state while the pipeline runs. */
export function ThinkingMessage() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep(s => Math.min(s + 1, STEPS.length - 1)), 1700);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="msg" aria-live="polite">
      <BotAvatar />
      <div className="bot-body">
        <div className="thinking">
          {STEPS.map((text, i) => (
            <div key={text} className={`think-step ${i < step ? 'done' : i === step ? 'now' : ''}`} style={{ display: i > step ? 'none' : 'flex' }}>
              {i < step ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} className="spin" aria-hidden="true" />}
              <span>{text}{i === step && <span className="dots"><span /><span /><span /></span>}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function IncompleteMessage({ attempt }) {
  const missing = attempt.missing_sections ?? [];
  const escalated = attempt.escalated;
  return (
        <div className="card assess">
          <div className="verdict-banner tone-bad">
            <span className="vb-icon"><AlertTriangle size={22} aria-hidden="true" /></span>
            <div className="grow">
              <h3>{escalated ? 'Sent to a manager' : 'Something is missing'}</h3>
              <p>{escalated
                ? 'The report was still missing a part after three tries, so a manager will take a look.'
                : 'A report needs all three parts before it can be scored. Add the missing part and send it again.'}</p>
            </div>
            <Pips attempt={attempt.attempt_number} passed={false} escalated={escalated} />
          </div>
          <div className="assess-sec">
            <h4>Missing</h4>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {missing.map(code => {
                const s = SECTIONS.find(x => x.code === code);
                return <span key={code} className={`chip tag-${code}`}>{s && <StepDot s={s} />}{SECTION_NAMES[code] ?? code}</span>;
              })}
            </div>
            <p className="muted" style={{ marginTop: 10, fontSize: 13.5 }}>
              Tip: write the missing part as a full sentence. For Expected Behaviour, use the word "should".
            </p>
          </div>
        </div>
  );
}

function Rec({ rec, index }) {
  return (
    <div className="rec">
      <div className="rec-top">
        <span className="num">{index + 1}</span>
        <b>{shortIssueTag(rec.issue)}</b>
      </div>
      {rec.sentence_reference && <div className="rec-quote"><span>From your report</span>{rec.sentence_reference}</div>}
      <div className="rec-fix"><span>Try this</span>{rec.suggested_fix}</div>
    </div>
  );
}

const dimName = (key) => DIMENSIONS.find(d => d.key === key)?.label ?? String(key ?? '').replace(/_/g, ' ');
const prettyMarker = (m) => {
  const t = String(m ?? 'Deduction').replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function PointsLost({ items }) {
  if (!items?.length) {
    return <p className="muted" style={{ fontSize: 14 }}>No individual deductions were listed for this score. The full explanation tab has the scorer's reasoning.</p>;
  }
  const total = items.reduce((n, d) => n + Math.abs(Number(d.points) || 0), 0);
  return (
    <div>
      <p style={{ fontSize: 14, marginBottom: 10 }}>You lost <b>{total} points</b> in total, for these reasons:</p>
      {items.map((d, i) => (
        <div className="lost-row" key={i}>
          <span className="lost-pts">-{Math.abs(Number(d.points) || 0)}</span>
          <div className="grow">
            <b>{prettyMarker(d.marker)}</b>
            <span className="muted"> · {dimName(d.dimension)}</span>
            {d.evidence && <div className="lost-ev">"{d.evidence}"</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Why({ attempt }) {
  return (
    <div>
      {attempt.reasoning
        ? <p style={{ fontSize: 14.5, whiteSpace: 'pre-wrap' }}>{attempt.reasoning}</p>
        : <p className="muted" style={{ fontSize: 14 }}>The scorer did not give a written explanation.</p>}
      <div className="how">
        <b>How scoring works</b>
        <p>Every report is marked out of 100 across four areas. You need {PASS_THRESHOLD} to pass.</p>
        <ul>
          {DIMENSIONS.map(d => <li key={d.key}><b>{d.label}</b> (up to {d.max}): {d.hint}</li>)}
        </ul>
      </div>
    </div>
  );
}

/**
 * The scored result, built to be read top to bottom in ten seconds:
 *   1. a plain verdict, 2. the score and four areas, 3. tabs for what to fix /
 *   where points were lost / the full explanation.
 */
export function AssessmentCard({ attempt, canRate = false }) {
  const { api, toast } = useApp();
  const recs = attempt.recommendations ?? [];
  const [tab, setTab] = useState(recs.length ? 'fix' : 'why');
  const [vote, setVote] = useState(attempt.user_feedback?.helpful ?? null);
  const passed = attempt.passed === true;
  const score = Number(attempt.total_score) || 0;
  const v = verdictFor(score, passed);
  const VIcon = { good: CheckCircle2, warn: Good, bad: XCircle }[v.tone];

  const rate = async (helpful) => {
    setVote(helpful);
    const res = await api(`/reports/${attempt.report_id}/feedback`, { method: 'POST', body: { helpful } }).catch(() => null);
    toast(res?.status === 200 ? 'Thanks for the feedback' : 'Could not save your rating');
  };
  const copyReport = async () => toast((await copyText(reportAsText(attempt))) ? 'Report copied' : 'Could not copy');

  const lostCount = attempt.deductions_applied?.length ?? 0;
  const tabs = [
    { key: 'fix',  label: 'What to fix', count: recs.length },
    { key: 'lost', label: 'Where points were lost', count: lostCount },
    { key: 'why',  label: 'Full explanation' },
  ];

  return (
    <div className="card assess">
      <div className={`verdict-banner tone-${v.tone}`}>
        <span className="vb-icon"><VIcon size={24} aria-hidden="true" /></span>
        <div className="grow">
          <h3>{attempt.escalated ? 'Sent to a manager' : v.title}</h3>
          <p>{attempt.escalated ? `It scored ${score}, below the ${PASS_THRESHOLD} needed, and has no tries left. A manager will review it.` : v.sub}</p>
        </div>
        <Pips attempt={attempt.attempt_number} passed={passed} escalated={attempt.escalated} />
      </div>

      <div className="assess-body">
        <ScoreRing score={score} />
        <DimensionBars scores={attempt.dimension_scores} />
      </div>

      <div className="tabs" role="tablist" aria-label="Details">
        {tabs.map(t => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}{t.count > 0 && <span className="n">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel">
        {tab === 'fix' && (recs.length
          ? recs.map((r, i) => <Rec key={`${attempt.report_id}-${i}`} rec={r} index={i} />)
          : <p className="muted" style={{ fontSize: 14 }}>Nothing to fix. This report is already clear and detailed.</p>)}
        {tab === 'lost' && <PointsLost items={attempt.deductions_applied} />}
        {tab === 'why' && <Why attempt={attempt} />}
        {attempt.c2_parsed_ok === false && (
          <div className="alert alert-info" style={{ marginTop: 12 }}><AlertTriangle size={16} aria-hidden="true" />
            The scorer's answer was partly unreadable, so some details may be missing.
          </div>
        )}
      </div>

      <div className="assess-foot">
        {passed && <button className="btn btn-sm" onClick={copyReport}><ClipboardCopy size={14} aria-hidden="true" />Copy report</button>}
        <span className="grow" />
        {canRate && (
          <span className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>Was this useful?</span>
            <button className={`btn btn-sm ${vote === true ? 'btn-primary' : ''}`} onClick={() => rate(true)} aria-pressed={vote === true} aria-label="Yes, useful"><ThumbsUp size={14} aria-hidden="true" /></button>
            <button className={`btn btn-sm ${vote === false ? 'btn-primary' : ''}`} onClick={() => rate(false)} aria-pressed={vote === false} aria-label="No, not useful"><ThumbsDown size={14} aria-hidden="true" /></button>
          </span>
        )}
      </div>
    </div>
  );
}

export function AssessmentMessage({ attempt, canRate = false }) {
  return (
    <div className="msg">
      <BotAvatar />
      <div className="bot-body"><AssessmentCard attempt={attempt} canRate={canRate} /></div>
    </div>
  );
}

/** Manager's decision, shown to everyone who can see the thread. */
export function ReviewNote({ review }) {
  if (!review) return null;
  const accepted = review.decision === 'accepted';
  return (
        <div className="card review-note" style={{ padding: '14px 16px' }}>
          <div className="row" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
            <span className={`chip ${accepted ? 'chip-good' : 'chip-warn'}`}>
              {accepted ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
              {accepted ? 'A manager accepted this report' : 'A manager sent this back for rework'}
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>{review.reviewer} · {formatDateTime(review.reviewed_at)}</span>
          </div>
          {review.note ? <p style={{ fontSize: 14.5, whiteSpace: 'pre-wrap' }}>{review.note}</p>
            : <p className="muted" style={{ fontSize: 14 }}>No note was left.</p>}
        </div>
  );
}

/** Every attempt of a thread, in order. Used by the QA chat. */
export function Transcript({ attempts, canRate = false }) {
  return (
    <>
      {attempts.map((a, i) => (
        <div key={a.report_id} data-last-attempt={i === attempts.length - 1 ? 'true' : undefined}>
          {attempts.length > 1 && <div className="attempt-label">Try {a.attempt_number}</div>}
          <UserBubble attempt={a} />
          {a.status === 'rejected_incomplete'
            ? <IncompleteMessage attempt={a} />
            : <AssessmentMessage attempt={a} canRate={canRate && i === attempts.length - 1} />}
        </div>
      ))}
    </>
  );
}
