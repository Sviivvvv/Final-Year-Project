/**
 * App.jsx — Bug Report Quality Assessment UI (Mid-Point scope)
 *
 * Views:
 *   'form'         — empty submission form
 *   'loading'      — form locked, submitting spinner
 *   'result'       — results card + inline EditPanel below
 *   'resubmitting' — result card + EditPanel locked, resubmit spinner
 *
 * Resubmission loop (Mid-Point): thread_id is carried from the first
 * response and sent back on every resubmit, so the backend can enforce the
 * 3-attempt cap against the SAME thread rather than starting a new one each
 * time. Once a thread is escalated (3 failed attempts) or has passed, the
 * edit panel locks instead of letting the user attempt a resubmit that the
 * backend would just reject with a 409.
 */

import { useState, useEffect } from 'react';
import {
  Bug, Eye, Crosshair, List, Lock, Send, RefreshCw,
  PlusCircle, CheckCircle2, AlertTriangle, Zap, ShieldCheck,
  Loader2, Info, ShieldAlert,
} from 'lucide-react';
import RoleBadge from './components/RoleBadge.jsx';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_CHARS = 2000;
const MAX_ATTEMPTS = 3;

const FIELDS_CONFIG = [
  {
    key:         'observed_behavior',
    label:       'Observed Behavior',
    subtitle:    'What actually happened',
    placeholder: 'Describe what actually happened...',
    sectionCode: 'OB',
    Icon:        Eye,
    iconBg:      'bg-indigo-100',
    iconColor:   'text-indigo-500',
    rows:        3,
  },
  {
    key:         'expected_behavior',
    label:       'Expected Behavior',
    subtitle:    'What should have happened',
    placeholder: 'Describe what should have happened...',
    sectionCode: 'EB',
    Icon:        Crosshair,
    iconBg:      'bg-blue-100',
    iconColor:   'text-blue-500',
    rows:        3,
  },
  {
    key:         'steps_to_reproduce',
    label:       'Steps to Reproduce',
    subtitle:    'Numbered steps to reproduce the bug',
    placeholder: '1. First step...\n2. Second step...',
    sectionCode: 'S2R',
    Icon:        List,
    iconBg:      'bg-green-100',
    iconColor:   'text-green-500',
    rows:        4,
  },
];

const DIMENSION_CONFIG = {
  clarity:             { label: 'Clarity',             Icon: Eye,        color: 'text-indigo-500' },
  specificity:         { label: 'Specificity',         Icon: Crosshair,  color: 'text-blue-500'   },
  logical_consistency: { label: 'Logical Consistency', Icon: Zap,        color: 'text-amber-500'  },
  actionability:       { label: 'Actionability',       Icon: ShieldCheck, color: 'text-green-500' },
};

const SECTION_NAMES = {
  OB:  'Observed Behavior (OB)',
  EB:  'Expected Behavior (EB)',
  S2R: 'Steps to Reproduce (S2R)',
};

const EMPTY_FIELDS = {
  observed_behavior:  '',
  expected_behavior:  '',
  steps_to_reproduce: '',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortIssueTag(issue = '') {
  const SKIP = new Set(['the','a','an','there','is','it','no','not','too','are','report','lacks']);
  const words = issue.split(' ').filter(w => !SKIP.has(w.toLowerCase()));
  let tag = '';
  for (const w of words) {
    const next = tag ? `${tag} ${w}` : w;
    if (next.length > 14) break;
    tag = next;
  }
  return tag || issue.slice(0, 12);
}

/**
 * threadId is omitted (undefined -> not sent) on a brand-new submission, and
 * included on a resubmit so the backend can enforce the 3-attempt cap against
 * the same thread instead of starting a new one.
 */
async function callApi(fields, threadId, token) {
  const res = await fetch('/reports', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body:    JSON.stringify(threadId ? { ...fields, thread_id: threadId } : fields),
  });
  const data = await res.json();
  // Attach the HTTP status so callers can distinguish e.g. a 409
  // (already escalated / already passed) from a normal 200/400 result.
  return { ...data, _httpStatus: res.status };
}

/**
 * FadeIn — subtle mount transition, no Tailwind config changes needed
 * (opacity + translate are core utilities, work fine with the Play CDN).
 */
function FadeIn({ children, className = '' }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 10);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className={`transition-all duration-500 ease-out ${show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'} ${className}`}>
      {children}
    </div>
  );
}

/**
 * ScoreRing — a single animated ring showing one number (the total score).
 * Deliberately NOT a chart/graph (no series, no comparison, no aggregation)
 * -- it's the same "100/100" figure the old plain text showed, just drawn.
 */
function ScoreRing({ score, passed }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setProgress(score), 150);
    return () => clearTimeout(t);
  }, [score]);

  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (progress / 100) * circumference;
  const color = passed ? '#22c55e' : '#ef4444';

  return (
    <div className="relative w-28 h-28 flex-shrink-0">
      <svg className="w-28 h-28 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="9" />
        <circle
          cx="60" cy="60" r={radius} fill="none" stroke={color} strokeWidth="9"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-slate-800 leading-none">{score}</span>
        <span className="text-[11px] text-slate-400 mt-0.5">/ 100</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormView
// ---------------------------------------------------------------------------

function FormView({ fields, setFields, onSubmit, loading, networkError, role, onLogout }) {
  const allFilled = FIELDS_CONFIG.every(f => fields[f.key].trim().length > 0);

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <FadeIn className="max-w-2xl mx-auto">

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-100 p-2.5 rounded-xl">
              <Bug className="text-indigo-500 w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-800">Submit Bug Report</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                Provide clear and complete details to help us assess the quality of your bug report.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {role && <RoleBadge role={role} />}
            {onLogout && (
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                Log out
              </button>
            )}
          </div>
        </div>

        {networkError && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            {networkError}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow duration-300">
          <div className="space-y-6">
            {FIELDS_CONFIG.map(({ key, label, subtitle, placeholder, Icon, iconBg, iconColor, rows }) => (
              <div key={key}>
                <div className="flex items-center gap-3 mb-2.5">
                  <div className={`${iconBg} p-2 rounded-lg flex-shrink-0`}>
                    <Icon className={`${iconColor} w-4 h-4`} />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 text-sm">{label}</p>
                    <p className="text-slate-400 text-xs">{subtitle}</p>
                  </div>
                </div>
                <div className="relative">
                  <textarea
                    value={fields[key]}
                    onChange={e => setFields(prev => ({ ...prev, [key]: e.target.value.slice(0, MAX_CHARS) }))}
                    placeholder={placeholder}
                    rows={rows}
                    disabled={loading}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-3 text-sm text-slate-700 placeholder-slate-300 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-slate-50 disabled:text-slate-400 transition-colors"
                  />
                  <span className="absolute bottom-2.5 right-3 text-xs text-slate-300 select-none">
                    {fields[key].length} / {MAX_CHARS}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mt-6 pt-5 border-t border-slate-100">
            <div className="flex items-center gap-1.5 text-slate-400 text-xs">
              <Lock className="w-3 h-3" />
              Your report is secure and used only for quality assessment.
            </div>
            <button
              onClick={onSubmit}
              disabled={loading || !allFilled}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-all duration-150 shadow-sm hover:shadow-md active:scale-95"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" />Submitting...</>
              ) : (
                <><Send className="w-4 h-4" />Submit Report</>
              )}
            </button>
          </div>
        </div>

      </FadeIn>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultsView
// ---------------------------------------------------------------------------

function ResultsView({ result, fields, onResubmit, onReset, resubmitting, resubmitError, role, onLogout }) {
  const isIncomplete = result?.status === 'rejected_incomplete';
  const isEscalated  = result?.escalated === true;
  const isPassed     = result?.passed === true;
  const attemptNumber = result?.attempt_number ?? 1;

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <FadeIn className="max-w-4xl mx-auto space-y-5">

        {/* Header — no duplicate button here */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Report Assessment</h1>
            <p className="text-slate-400 text-sm mt-0.5">Here's the assessment of your bug report.</p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {role && <RoleBadge role={role} />}
            {onLogout && (
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                Log out
              </button>
            )}
          </div>
        </div>

        {/* Attempt indicator */}
        {!isPassed && (
          <div className="flex items-center gap-1.5 text-slate-400 text-xs -mt-2">
            <Info className="w-3.5 h-3.5" />
            Attempt {attemptNumber} of {MAX_ATTEMPTS}
          </div>
        )}

        {/* Result card */}
        {isIncomplete
          ? <IncompleteCard result={result} />
          : <ScoredCard result={result} />
        }

        {/* Escalation notice — shown instead of an editable panel once locked */}
        {isEscalated ? (
          <EscalatedNotice />
        ) : (
          <EditPanel
            initialFields={fields}
            missingSections={isIncomplete ? (result.missing_sections ?? []) : []}
            onResubmit={onResubmit}
            onReset={onReset}
            loading={resubmitting}
            locked={isPassed}
            lockedReason={isPassed ? 'This report has already passed and does not need to be resubmitted.' : null}
            resubmitError={resubmitError}
          />
        )}

      </FadeIn>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EscalatedNotice — shown once a thread hits the 3-attempt cap
// ---------------------------------------------------------------------------

function EscalatedNotice() {
  return (
    <div className="bg-white border border-red-200 rounded-2xl p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="bg-red-100 p-2.5 rounded-full flex-shrink-0">
          <ShieldAlert className="text-red-500 w-5 h-5" />
        </div>
        <div>
          <h2 className="text-red-600 font-bold text-base">Escalated to a Manager</h2>
          <p className="text-slate-500 text-sm mt-0.5">
            This report did not pass after {MAX_ATTEMPTS} attempts and has been escalated for manual
            review. It can no longer be edited or resubmitted here.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IncompleteCard — no Try Again button (EditPanel handles it)
// ---------------------------------------------------------------------------

export function IncompleteCard({ result }) {
  return (
    <div className="bg-white border border-red-200 rounded-2xl p-6 shadow-sm">
      <div className="flex items-start gap-3 mb-3">
        <div className="bg-red-100 p-2.5 rounded-full flex-shrink-0">
          <AlertTriangle className="text-red-500 w-5 h-5" />
        </div>
        <div>
          <h2 className="text-red-600 font-bold text-base">Report Incomplete</h2>
          <p className="text-slate-500 text-sm mt-0.5">
            Your report is missing required section(s). Edit the fields below and resubmit.
          </p>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4 mt-2">
        <p className="text-slate-700 font-semibold text-sm mb-2">Missing Sections</p>
        <ul className="space-y-1.5">
          {(result.missing_sections ?? []).map(code => (
            <li key={code} className="flex items-center gap-2 text-slate-600 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
              {SECTION_NAMES[code] ?? code}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScoredCard — no Submit Another button (EditPanel handles it)
// ---------------------------------------------------------------------------

export function ScoredCard({ result }) {
  const {
    total_score      = 0,
    passed           = false,
    dimension_scores = {},
    recommendations  = [],
  } = result;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 overflow-hidden">

      {/* Score banner */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
        <div>
          <span className={`inline-flex items-center gap-1.5 px-5 py-2 rounded-full text-sm font-bold tracking-wide ${
            passed ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
          }`}>
            {passed
              ? <CheckCircle2 className="w-4 h-4" />
              : <AlertTriangle className="w-4 h-4" />
            }
            {passed ? 'PASS' : 'FAIL'}
          </span>
          <p className="text-slate-400 text-xs mt-2">Overall Quality Score</p>
        </div>
        <ScoreRing score={total_score} passed={passed} />
      </div>

      <div className="p-6 space-y-6">

        {/* Dimension scores */}
        {Object.keys(dimension_scores).length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="font-semibold text-slate-800 text-sm">Dimension Scores</p>
              <Info className="w-3.5 h-3.5 text-slate-400" />
            </div>
            <div className="space-y-3">
              {Object.entries(dimension_scores).map(([key, value]) => {
                const cfg = DIMENSION_CONFIG[key] ?? { label: key, Icon: Info, color: 'text-slate-400' };
                return (
                  <div key={key} className="flex items-center gap-3 rounded-lg -mx-2 px-2 py-1 hover:bg-slate-50 transition-colors">
                    <cfg.Icon className={`w-4 h-4 ${cfg.color} flex-shrink-0`} />
                    <span className="text-slate-600 text-sm flex-1">{cfg.label}</span>
                    <span className="text-slate-700 text-sm font-semibold">{value}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div>
            <p className="font-semibold text-slate-800 text-sm mb-3">Recommendations</p>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left text-slate-500 font-semibold px-4 py-2.5 w-1/4">Sentence</th>
                    <th className="text-left text-slate-500 font-semibold px-4 py-2.5 w-1/5">Issue</th>
                    <th className="text-left text-slate-500 font-semibold px-4 py-2.5">Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {recommendations.map((rec, i) => (
                    <tr key={i} className={`hover:bg-slate-50 transition-colors ${i < recommendations.length - 1 ? 'border-b border-slate-100' : ''}`}>
                      <td className="px-4 py-3 text-slate-600 align-top">{rec.sentence_reference}</td>
                      <td className="px-4 py-3 align-top">
                        <span className="inline-block bg-amber-100 text-amber-700 font-medium px-2 py-0.5 rounded-full">
                          {shortIssueTag(rec.issue)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 align-top">{rec.suggested_fix}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditPanel — inline editable fields shown below the result card
// ---------------------------------------------------------------------------

function EditPanel({ initialFields, missingSections, onResubmit, onReset, loading, locked, lockedReason, resubmitError }) {
  const [fields, setFields] = useState(initialFields);
  const allFilled = FIELDS_CONFIG.every(f => fields[f.key].trim().length > 0);

  if (locked) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-green-100 p-2.5 rounded-full flex-shrink-0">
              <CheckCircle2 className="text-green-500 w-5 h-5" />
            </div>
            <p className="text-slate-600 text-sm">{lockedReason}</p>
          </div>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 text-sm transition-colors flex-shrink-0"
          >
            <PlusCircle className="w-4 h-4" />
            Submit another report
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">

      {/* Panel header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="font-bold text-slate-800 text-base">Edit &amp; Resubmit</h2>
          <p className="text-slate-400 text-sm mt-0.5">
            Update your report and resubmit for a fresh assessment.
          </p>
        </div>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 text-sm transition-colors"
        >
          <PlusCircle className="w-4 h-4" />
          Start fresh
        </button>
      </div>

      {resubmitError && (
        <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {resubmitError}
        </div>
      )}

      {/* Editable fields */}
      <div className="space-y-5">
        {FIELDS_CONFIG.map(({ key, label, placeholder, sectionCode, Icon, iconBg, iconColor, rows }) => {
          const isMissing = missingSections.includes(sectionCode);
          return (
            <div key={key}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`${iconBg} p-1.5 rounded-lg flex-shrink-0`}>
                  <Icon className={`${iconColor} w-3.5 h-3.5`} />
                </div>
                <span className="font-semibold text-slate-700 text-sm">{label}</span>
                {isMissing && (
                  <span className="text-xs bg-red-100 text-red-600 font-medium px-2 py-0.5 rounded-full">
                    Missing
                  </span>
                )}
              </div>
              <div className="relative">
                <textarea
                  value={fields[key]}
                  onChange={e => setFields(prev => ({ ...prev, [key]: e.target.value.slice(0, MAX_CHARS) }))}
                  placeholder={placeholder}
                  rows={rows}
                  disabled={loading}
                  className={`w-full border rounded-xl px-3.5 py-3 text-sm text-slate-700 placeholder-slate-300 resize-none focus:outline-none focus:ring-2 disabled:bg-slate-50 disabled:text-slate-400 transition-colors ${
                    isMissing
                      ? 'border-red-300 focus:ring-red-200 focus:border-red-400'
                      : 'border-slate-200 focus:ring-indigo-300 focus:border-indigo-300'
                  }`}
                />
                <span className="absolute bottom-2.5 right-3 text-xs text-slate-300 select-none">
                  {fields[key].length} / {MAX_CHARS}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Panel footer */}
      <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
        <div className="flex items-center gap-1.5 text-slate-400 text-xs">
          <Lock className="w-3 h-3" />
          Your report is secure and used only for quality assessment.
        </div>
        <button
          onClick={() => onResubmit(fields)}
          disabled={loading || !allFilled}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-all duration-150 shadow-sm hover:shadow-md active:scale-95"
        >
          {loading ? (
            <><Loader2 className="w-4 h-4 animate-spin" />Resubmitting...</>
          ) : (
            <><RefreshCw className="w-4 h-4" />Resubmit Report</>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App — state machine
// ---------------------------------------------------------------------------

export default function App({ token, role, onLogout }) {
  const [view,          setView]          = useState('form');
  const [fields,        setFields]        = useState(EMPTY_FIELDS);
  const [result,        setResult]        = useState(null);
  const [threadId,      setThreadId]      = useState(null);
  const [networkError,  setNetworkError]  = useState(null);
  const [resubmitting,  setResubmitting]  = useState(false);
  const [resubmitError, setResubmitError] = useState(null);

  const handleSubmit = async () => {
    setView('loading');
    setNetworkError(null);
    try {
      // No threadId here -- this is always a fresh submission / new thread.
      const data = await callApi(fields, null, token);
      setResult(data);
      setThreadId(data.thread_id ?? null);
      setView('result');
    } catch (err) {
      setNetworkError('Could not reach the server. Make sure the backend is running on localhost:3000.');
      setView('form');
    }
  };

  const handleResubmit = async (newFields) => {
    setResubmitting(true);
    setResubmitError(null);
    setFields(newFields);
    try {
      const data = await callApi(newFields, threadId, token);

      if (data._httpStatus === 409) {
        // Thread was escalated or already passed between renders (e.g. two
        // tabs open, or the state got out of sync) -- surface it rather than
        // silently discarding the attempt.
        setResubmitError(data.error ?? 'This report thread can no longer be resubmitted.');
        return;
      }

      setResult(data);
      if (data.thread_id) setThreadId(data.thread_id);
    } catch (err) {
      setResubmitError('Could not reach the server. Make sure the backend is running on localhost:3000.');
    } finally {
      setResubmitting(false);
    }
  };

  const handleReset = () => {
    setFields(EMPTY_FIELDS);
    setResult(null);
    setThreadId(null);
    setNetworkError(null);
    setResubmitError(null);
    setResubmitting(false);
    setView('form');
  };

  if (view === 'result') {
    return (
      <ResultsView
        result={result}
        fields={fields}
        onResubmit={handleResubmit}
        onReset={handleReset}
        resubmitting={resubmitting}
        resubmitError={resubmitError}
        role={role}
        onLogout={onLogout}
      />
    );
  }

  return (
    <FormView
      fields={fields}
      setFields={setFields}
      onSubmit={handleSubmit}
      loading={view === 'loading'}
      networkError={networkError}
      role={role}
      onLogout={onLogout}
    />
  );
}
