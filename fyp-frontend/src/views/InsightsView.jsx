import { useEffect, useMemo, useState } from 'react';
import { BarChart3, AlertTriangle, ArrowUp, ArrowDown, Minus, ChevronRight } from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import { DIMENSIONS, tone, displayName, initials } from '../lib/format.js';
import { StatTile, ChartCard, Histogram, TrendLine, HBars, OutcomeStack } from '../components/Charts.jsx';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
];

const fmt = (v, d = 0) => (v === null || v === undefined ? '-' : Number(v).toFixed(d).replace(/\.0+$/, ''));
const SECTION_LABEL = { OB: 'Observed Behaviour', EB: 'Expected Behaviour', S2R: 'Steps to Reproduce' };
const SHORT_LABEL = { OB: 'Observed', EB: 'Expected', S2R: 'Steps' };

/** Small up/down change, or nothing at all when there is nothing to compare with. */
function Delta({ now, before, unit = '' }) {
  if (before === null || before === undefined || now === null || now === undefined) return null;
  const d = Math.round((now - before) * 10) / 10;
  if (d === 0) return <span className="delta flat"><Minus size={13} aria-hidden="true" />no change</span>;
  const up = d > 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {up ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}{Math.abs(d)}{unit} vs before
    </span>
  );
}

function Trend({ from, to }) {
  if (from === null || to === null) return <span className="muted">-</span>;
  const d = Math.round((to - from) * 10) / 10;
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return (
    <span className={`delta ${cls}`}>
      {d > 0 ? <ArrowUp size={13} aria-hidden="true" /> : d < 0 ? <ArrowDown size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
      {d > 0 ? '+' : ''}{d}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview: four numbers, one trend, two answers
// ---------------------------------------------------------------------------

function Overview({ data, staff }) {
  const { navigate } = useApp();
  const t = data.totals;
  const learn = data.learning;
  const lrows = learn.by_report;

  return (
    <>
      <div className="tiles">
        <StatTile hero label="Average score" value={fmt(t.avg_score, 1)} unit="/ 100" sub={<Delta now={t.avg_score} before={data.previous?.avg_score} />} />
        <StatTile label="Pass rate" value={fmt(t.pass_rate)} unit="%" sub={`${fmt(t.first_try_pass_rate)}% first try`} />
        <StatTile label="Reports" value={t.threads} sub={`${t.attempts} tries`} />
        {staff
          ? <StatTile label="Waiting for you" value={data.escalations.waiting} sub={data.escalations.waiting ? 'in the review queue' : 'all clear'} />
          : <StatTile label="Tries to pass" value={fmt(t.avg_attempts_to_pass, 1)} sub="on average" />}
      </div>

      <div style={{ marginBottom: 18 }}>
        <ChartCard title="Average score by day" info="Days without any tries are skipped. The dashed line is the pass mark (60)."
          table={{ columns: ['Day', 'Tries', 'Average score'], rows: data.trend.filter(p => p.avg !== null).map(p => [p.date, p.count, p.avg]) }}>
          {data.trend.some(p => p.avg !== null) ? <TrendLine points={data.trend} /> : <p className="muted">No scored tries in this range.</p>}
        </ChartCard>
      </div>

      <div className="grid-2">
        <ChartCard
          title={staff ? 'Are reporters improving?' : 'Are you improving?'}
          info="First-try score on each person's 1st, 2nd, 3rd... report. Only first tries count, so this shows learning between reports, not fixes made after feedback."
          table={{ columns: ['Report', 'Reporters', 'Avg first-try score'], rows: lrows.map(r => [r.report_no, r.reporters, r.avg_first_try]) }}
        >
          {lrows.length < 2 ? <p className="muted">Needs two or more reports per person.</p> : (
            <>
              <HBars colorBy="tone" rows={lrows.map(r => ({
                label: `Report ${r.report_no}`, value: r.avg_first_try, max: 100, tonePct: r.avg_first_try, display: fmt(r.avg_first_try),
                title: `${r.reporters} ${r.reporters === 1 ? 'reporter' : 'reporters'}`,
              }))} />
              {learn.avg_gain_first_to_latest !== null && (
                <div className="card-foot">First → latest report <Trend from={0} to={learn.avg_gain_first_to_latest} /></div>
              )}
            </>
          )}
        </ChartCard>

        <ChartCard title="Most common problems" info={staff ? 'How often each kind of suggestion was given. Click one to see those reports.' : 'How often each kind of suggestion was given.'}
          table={{ columns: ['Problem', 'Times'], rows: data.top_issues.map(i => [i.tag, i.count]) }}>
          {data.top_issues.length === 0 ? <p className="muted">No suggestions yet.</p> : (
            <HBars rows={data.top_issues.slice(0, 5).map(i => ({
              label: i.tag, value: i.count, max: data.top_issues[0].count, display: i.count,
              onClick: staff ? () => navigate(`reports/all?tag=${encodeURIComponent(i.tag)}`) : undefined,
            }))} />
          )}
        </ChartCard>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail: where points go, what blocks reports, how they end
// ---------------------------------------------------------------------------

function Details({ data }) {
  const sc = data.structure_check;
  const missing = data.missing_sections;
  const missMax = Math.max(1, ...Object.values(missing));
  const imp = data.improvement;
  const dims = data.dimensions.filter(d => d.avg !== null).map(d => {
    const meta = DIMENSIONS.find(x => x.key === d.key);
    return { label: meta?.label ?? d.key, value: d.avg, max: d.max, display: `${fmt(d.avg, 1)}/${d.max}`, title: meta?.hint, tonePct: (d.avg / d.max) * 100 };
  });

  return (
    <>
      <div className="grid-2">
        <ChartCard title="Score by area" info="Average in each rubric area, out of its maximum."
          table={{ columns: ['Area', 'Average', 'Maximum'], rows: dims.map(r => [r.label, r.value, r.max]) }}>
          <HBars colorBy="tone" rows={dims} />
        </ChartCard>

        <ChartCard title="Stopped before scoring" info="Tries the structure check sent back because it could not find a part. A high number can mean reporters skip that part, or that the classifier misses it (short steps are a known weak spot)."
          table={{ columns: ['Part not found', 'Tries'], rows: Object.entries(missing).map(([k, v]) => [SECTION_LABEL[k], v]) }}>
          <div className="big-stat"><b>{fmt(sc.blocked_rate)}%</b><span>{sc.blocked} of {sc.checked} tries</span></div>
          {sc.blocked > 0 && <HBars rows={Object.entries(missing).map(([k, v]) => ({ label: SHORT_LABEL[k], title: SECTION_LABEL[k], value: v, max: missMax, display: v }))} />}
        </ChartCard>
      </div>

      <div className="grid-2">
        <ChartCard title="Score spread" info="Number of tries in each 10-point band."
          table={{ columns: ['Band', 'Tries'], rows: data.distribution.map(b => [`${b.from}-${b.to}`, b.count]) }}>
          <Histogram bins={data.distribution} />
        </ChartCard>

        <ChartCard title="How reports ended" info="One count per report."
          table={{ columns: ['Outcome', 'Reports'], rows: Object.entries(data.outcomes).map(([k, v]) => [k.replace(/_/g, ' '), v]) }}>
          <OutcomeStack outcomes={data.outcomes} />
        </ChartCard>
      </div>

      <div className="tiles tiles-2" style={{ marginTop: 0 }}>
        <StatTile label="Revising helps" value={imp.avg_revision_gain === null ? '-' : `${imp.avg_revision_gain > 0 ? '+' : ''}${fmt(imp.avg_revision_gain, 1)}`} unit={imp.avg_revision_gain === null ? '' : 'pts'}
          sub={imp.revised_threads ? `first to last try, ${imp.revised_threads} reports` : 'no revised reports yet'} />
        <StatTile label="Feedback rated useful" value={fmt(data.assistant_feedback.helpful_rate)} unit={data.assistant_feedback.rated ? '%' : ''}
          sub={`${data.assistant_feedback.rated} ratings`} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// People: one compact row each, click to see their reports
// ---------------------------------------------------------------------------

function People({ reporters }) {
  const { navigate } = useApp();
  if (!reporters?.length) return <div className="panel empty"><p>No reporters in this range.</p></div>;
  const sorted = [...reporters].sort((a, b) => (b.enough_data - a.enough_data) || ((a.avg_score ?? 101) - (b.avg_score ?? 101)));
  return (
    <div className="tlist">
      <div className="prow prow-head" aria-hidden="true">
        <span /><span>Reporter</span><span>Reports</span><span>Pass</span>
        <span title="Change in first-try score from their first report to their latest">Trend</span><span>Average</span><span />
      </div>
      {sorted.map(r => {
        const low = r.enough_data && r.avg_score !== null && tone(r.avg_score) === 'bad';
        return (
          <button className="prow" key={r.email} onClick={() => navigate(`reports/all?user=${encodeURIComponent(r.email)}`)}>
            <span className="avatar avatar-sm">{r.known ? initials(r.email) : '?'}</span>
            <span className="prow-who">
              <b>{r.known ? displayName(r.email) : 'Unknown'}</b>
              {low ? <span className="chip chip-bad">Needs support</span> : !r.enough_data ? <span className="muted prow-note">few reports</span> : null}
            </span>
            <span className="num">{r.threads}</span>
            <span className="num">{fmt(r.pass_rate)}%</span>
            <span><Trend from={r.first_try_first} to={r.first_try_latest} /></span>
            <span className="prow-bar">
              {r.avg_score === null ? <span className="muted">-</span> : (
                <HBars colorBy="tone" animate={false} rows={[{ label: '', value: r.avg_score, max: 100, display: fmt(r.avg_score), tonePct: r.avg_score }]} />
              )}
            </span>
            <ChevronRight size={16} className="muted" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export default function InsightsView() {
  const { api, auth, historyVersion } = useApp();
  const staff = auth.role !== 'qa';
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api(`/reports/analytics${days ? `?days=${days}` : ''}`)
      .then(res => { if (cancelled) return; if (res.status === 200) setData(res.data); else setError(res.data?.error ?? 'Could not load insights.'); })
      .catch(() => { if (!cancelled) setError('Could not reach the server.'); });
    return () => { cancelled = true; };
  }, [api, days, historyVersion]);

  const empty = data && data.totals.threads === 0;
  const tabs = useMemo(() => (staff
    ? [{ key: 'overview', label: 'Overview' }, { key: 'people', label: 'People' }, { key: 'details', label: 'Detail' }]
    : [{ key: 'overview', label: 'Overview' }, { key: 'details', label: 'Detail' }]), [staff]);

  return (
    <div className="scroll">
      <div className="col col-wide">
        <div className="page-head">
          <div className="grow"><h2>{staff ? 'Insights' : 'My progress'}</h2></div>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map(r => (
              <button key={r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)} aria-pressed={days === r.days}>{r.label}</button>
            ))}
          </div>
        </div>

        {error && <div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
        {!data && !error && <div className="tiles">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div>}

        {empty && (
          <div className="panel empty">
            <BarChart3 size={36} aria-hidden="true" />
            <p><b>Nothing to show yet.</b></p>
          </div>
        )}

        {data && !empty && (
          <>
            <div className="tabs tabs-page ins-tabs" role="tablist" aria-label="Insights sections">
              {tabs.map(t => (
                <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
              ))}
              <span className="grow" />
              {data.small_sample && (
                <span className="chip chip-warn" title="Fewer than 10 reports in this range, so treat the numbers as a rough guide.">
                  <AlertTriangle size={12} aria-hidden="true" />Small sample
                </span>
              )}
            </div>
            {tab === 'overview' && <Overview data={data} staff={staff} />}
            {tab === 'people' && staff && <People reporters={data.reporters} />}
            {tab === 'details' && <Details data={data} />}
          </>
        )}
      </div>
    </div>
  );
}
