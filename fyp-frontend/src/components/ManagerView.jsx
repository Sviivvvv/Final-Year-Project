/**
 * ManagerView.jsx — Manager's escalated reports list + read-only detail view.
 *
 * List stays deliberately bare per Mid-Point scope (no charts, no
 * aggregation/metrics beyond what's already in the table). The detail view
 * reuses the exact same ScoredCard / IncompleteCard components QA sees --
 * same score ring, same dimension breakdown, same recommendations table --
 * just without the edit/resubmit panel, since a Manager reviews, doesn't act.
 */

import { useEffect, useState } from 'react';
import {
  ShieldAlert, AlertTriangle, Loader2, Inbox, RefreshCw,
  ArrowLeft, Info,
} from 'lucide-react';
import { ScoredCard, IncompleteCard } from '../App.jsx';
import RoleBadge from './RoleBadge.jsx';

const MAX_ATTEMPTS = 3;

const STATUS_CONFIG = {
  scored: {
    label: 'Scored — Failed',
    className: 'bg-red-100 text-red-600',
  },
  rejected_incomplete: {
    label: 'Structurally Incomplete',
    className: 'bg-amber-100 text-amber-700',
  },
};

function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function shortId(id) {
  if (!id) return '—';
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

async function fetchEscalated(token) {
  const res = await fetch('/reports/escalated', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

async function fetchReportDetail(id, token) {
  const res = await fetch(`/reports/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

/**
 * FadeIn — mirrors the same subtle mount transition used in App.jsx, kept as
 * a local copy rather than a shared import to avoid adding a new shared file
 * for one small utility.
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

// ---------------------------------------------------------------------------
// Detail view — read-only, no edit/resubmit
// ---------------------------------------------------------------------------

function DetailView({ reportId, token, onBack }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReportDetail(reportId, token)
      .then(data => { if (!cancelled) setReport(data); })
      .catch(() => { if (!cancelled) setError('Could not load this report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reportId, token]);

  const isIncomplete = report?.status === 'rejected_incomplete';

  return (
    <FadeIn className="max-w-4xl mx-auto space-y-5">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 text-sm transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to escalated reports
      </button>

      {loading && (
        <div className="bg-white border border-slate-200 rounded-2xl flex items-center justify-center gap-2 text-slate-400 text-sm py-16 shadow-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading report...
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {report && !loading && (
        <>
          <div className="flex items-center gap-1.5 text-slate-400 text-xs">
            <Info className="w-3.5 h-3.5" />
            Attempt {report.attempt_number} of {MAX_ATTEMPTS} — this was the report's final attempt before escalation
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Submitted report</p>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-slate-400 text-xs mb-0.5">Observed Behavior</p>
                <p className="text-slate-700">{report.observed_behavior}</p>
              </div>
              <div>
                <p className="text-slate-400 text-xs mb-0.5">Expected Behavior</p>
                <p className="text-slate-700">{report.expected_behavior}</p>
              </div>
              <div>
                <p className="text-slate-400 text-xs mb-0.5">Steps to Reproduce</p>
                <p className="text-slate-700 whitespace-pre-line">{report.steps_to_reproduce}</p>
              </div>
            </div>
          </div>

          {isIncomplete
            ? <IncompleteCard result={report} />
            : <ScoredCard result={report} />
          }
        </>
      )}
    </FadeIn>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ListView({ reports, loading, error, onSelect }) {
  return (
    <>
      {error && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {loading && !reports ? (
          <div className="flex items-center justify-center gap-2 text-slate-400 text-sm py-16">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading escalated reports...
          </div>
        ) : reports && reports.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 text-slate-400 py-16">
            <Inbox className="w-8 h-8 text-slate-300" />
            <p className="text-sm">No escalated reports right now.</p>
          </div>
        ) : reports ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left text-slate-500 font-semibold px-5 py-3">Report</th>
                <th className="text-left text-slate-500 font-semibold px-5 py-3">Status</th>
                <th className="text-left text-slate-500 font-semibold px-5 py-3">Score</th>
                <th className="text-left text-slate-500 font-semibold px-5 py-3">Attempts</th>
                <th className="text-left text-slate-500 font-semibold px-5 py-3">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r, i) => {
                const status = STATUS_CONFIG[r.status] ?? { label: r.status, className: 'bg-slate-100 text-slate-500' };
                return (
                  <tr
                    key={r.report_id}
                    onClick={() => onSelect(r.report_id)}
                    className={`cursor-pointer hover:bg-slate-50 transition-colors ${i < reports.length - 1 ? 'border-b border-slate-100' : ''}`}
                  >
                    <td className="px-5 py-4 align-top">
                      <p className="text-slate-700 font-medium">{r.excerpt || '(no excerpt)'}</p>
                      <p className="text-slate-300 text-xs mt-1 font-mono">
                        {shortId(r.report_id)} · thread {shortId(r.thread_id)}
                      </p>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <span className={`inline-block ${status.className} font-medium px-2.5 py-1 rounded-full text-xs`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-5 py-4 align-top text-slate-600">
                      {r.total_score !== null && r.total_score !== undefined ? `${r.total_score} / 100` : '—'}
                    </td>
                    <td className="px-5 py-4 align-top text-slate-600">
                      {r.attempt_number} / {MAX_ATTEMPTS}
                    </td>
                    <td className="px-5 py-4 align-top text-slate-500 text-xs">
                      {formatTimestamp(r.submitted_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Root component — list <-> detail state, both behind the same header
// ---------------------------------------------------------------------------

export default function ManagerView({ token, role, email, onLogout }) {
  const [reports,    setReports]    = useState(null);
  const [loading,     setLoading]   = useState(true);
  const [error,       setError]     = useState(null);
  const [selectedId,  setSelectedId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEscalated(token);
      setReports(data.escalated_reports ?? []);
    } catch (err) {
      setError('Could not reach the server. Make sure the backend is running on localhost:3000.');
      setReports(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-4xl mx-auto">

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="bg-red-100 p-2.5 rounded-xl">
              <ShieldAlert className="text-red-500 w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-800">Escalated Reports</h1>
              <p className="text-slate-400 text-sm mt-0.5">
                Reports that failed all 3 attempts and require manual review.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 flex-shrink-0">
            {!selectedId && (
              <button
                onClick={load}
                disabled={loading}
                className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 text-sm transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            )}
            {role && <RoleBadge role={role} />}
            {onLogout && (
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                Log out
              </button>
            )}
          </div>
        </div>

        {selectedId ? (
          <DetailView reportId={selectedId} token={token} onBack={() => setSelectedId(null)} />
        ) : (
          <FadeIn>
            <ListView
              reports={reports}
              loading={loading}
              error={error}
              onSelect={setSelectedId}
            />
          </FadeIn>
        )}

      </div>
    </div>
  );
}
