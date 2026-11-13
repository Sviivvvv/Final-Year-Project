import { useEffect, useRef, useState } from 'react';
import { Table2, BarChart3, X, Info } from 'lucide-react';
import { PASS_THRESHOLD, tone, TONE_VAR, formatDay } from '../lib/format.js';
import { useCountUp } from '../lib/hooks.js';

/* ---------------------------------------------------------------------------
   Small hand-built SVG charts (no chart library). Shared behaviour:
   - hover shows exact numbers; click (or Enter) pins one item and explains it
     in a detail line under the chart, with a Clear button
   - everything else softly fades while something is pinned, so it never feels busy
   - every chart has a table view, status colours are always backed by text,
     and a legend appears whenever there are two or more series
--------------------------------------------------------------------------- */

export function StatTile({ label, value, unit, sub, hero = false }) {
  return (
    <div className={`tile ${hero ? 'hero-tile' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}{unit && <small> {unit}</small>}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Titled panel with a chart / table toggle so every chart has a non-visual twin. */
export function ChartCard({ title, sub, info, table, children }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="panel chart-card">
      <div className="ct">
        <div className="grow">
          <h3>{title}{info && <span className="info-tip" tabIndex={0} title={info} aria-label={info}><Info size={14} aria-hidden="true" /></span>}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {table && (
          <button className="btn btn-sm btn-ghost" onClick={() => setShowTable(v => !v)} aria-pressed={showTable}
            aria-label={showTable ? 'Show as chart' : 'Show as table'} title={showTable ? 'Show as chart' : 'Show as table'}>
            {showTable ? <BarChart3 size={15} aria-hidden="true" /> : <Table2 size={15} aria-hidden="true" />}
          </button>
        )}
      </div>
      {showTable && table ? (
        <table className="table">
          <thead><tr>{table.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      ) : children}
    </section>
  );
}

/** The line under a chart: hint when nothing is pinned, the pinned item's story when something is. */
function DetailLine({ hint, children, onClear }) {
  return (
    <div className={`chart-detail ${children ? 'on' : 'off'}`} aria-live="polite" title={hint}>
      {children && (
        <>
          <span className="grow">{children}</span>
          <button className="btn btn-sm" onClick={onClear} aria-label="Clear selection"><X size={13} aria-hidden="true" />Clear</button>
        </>
      )}
    </div>
  );
}

function useTip() {
  const boxRef = useRef(null);
  const [tip, setTip] = useState(null);
  // Draw at the real pixel width so text and dots never get stretched.
  const [width, setWidth] = useState(520);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const show = (e, text) => {
    const r = boxRef.current.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text });
  };
  const hide = () => setTip(null);
  const node = tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
  return { boxRef, show, hide, node, width };
}

const niceMax = (n) => {
  if (n <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 5, 10]) if (n <= m * pow) return m * pow;
  return n;
};

/** Bar with a 4px rounded top and a flat base. */
const barPath = (x, y, w, h) => {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
};

const activate = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

/** Score histogram, bars coloured by the same red / amber / green rule as the ring. Click a bar to pin it. */
export function Histogram({ bins }) {
  const { boxRef, show, hide, node, width } = useTip();
  const [sel, setSel] = useState(null);
  const W = width, H = 170, L = 30, R = 8, T = 18, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const max = niceMax(Math.max(1, ...bins.map(b => b.count)));
  const slot = pw / bins.length;
  const bw = Math.min(30, slot - 10);
  const ticks = [0, max / 2, max];
  const total = bins.reduce((n, b) => n + b.count, 0);
  const thresholdX = L + slot * (PASS_THRESHOLD / 10);
  const picked = sel !== null ? bins[sel] : null;
  const toggle = (i) => setSel(prev => (prev === i ? null : i));

  return (
    <div className="chart-box" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label="Distribution of attempt scores in bands of ten points">
        <g className="axis">
          {ticks.map(t => {
            const y = T + ph - (t / max) * ph;
            return <g key={t}><line className="gridline" x1={L} x2={W - R} y1={y} y2={y} /><text x={L - 6} y={y + 4} textAnchor="end">{Math.round(t)}</text></g>;
          })}
        </g>
        {bins.map((b, i) => {
          const h = (b.count / max) * ph;
          const x = L + slot * i + (slot - bw) / 2;
          const color = TONE_VAR[tone(b.from)];
          const dim = sel !== null && sel !== i;
          return (
            <g
              key={b.from} className={`bin ${sel === i ? 'picked' : ''} ${dim ? 'dim' : ''}`}
              role="button" tabIndex={0} aria-pressed={sel === i}
              aria-label={`${b.from} to ${b.to}: ${b.count} tries`}
              onClick={() => toggle(i)} onKeyDown={activate(() => toggle(i))}
              onMouseMove={e => show(e, `${b.from}-${b.to}: ${b.count} ${b.count === 1 ? 'try' : 'tries'}`)} onMouseLeave={hide}
            >
              <rect x={L + slot * i} y={T} width={slot} height={ph + 22} fill="transparent" />
              {b.count > 0 && <path d={barPath(x, T + ph - h, bw, h)} fill={color} stroke="var(--edge)" strokeWidth="1.5" />}
              {sel === i && b.count > 0 && <text x={x + bw / 2} y={T + ph - h - 6} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--ink)">{b.count}</text>}
              <text x={L + slot * i + slot / 2} y={H - 10} textAnchor="middle" style={{ fill: sel === i ? 'var(--ink)' : 'var(--ink-3)', fontSize: 11, fontWeight: sel === i ? 700 : 400 }}>{b.from}</text>
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={T + ph} y2={T + ph} stroke="var(--line-strong)" />
        <line x1={thresholdX} x2={thresholdX} y1={T - 4} y2={T + ph} stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="4 3" pointerEvents="none" />
        <text x={thresholdX + 5} y={T + 6} fontSize="11" fontWeight="700" fill="var(--ink-2)" pointerEvents="none">Pass {PASS_THRESHOLD}</text>
      </svg>
      {node}
      <div className="legend">
        <span><i className="swatch" style={{ background: 'var(--bad)' }} />Below pass mark</span>
        <span><i className="swatch" style={{ background: 'var(--warn)' }} />Passable (60-79)</span>
        <span><i className="swatch" style={{ background: 'var(--good)' }} />Strong (80+)</span>
      </div>
      <DetailLine hint="Click a bar to see what that score band means." onClear={() => setSel(null)}>
        {picked && <><b>{picked.from} to {picked.to}</b>: {picked.count} {picked.count === 1 ? 'try' : 'tries'}{total ? ` (${Math.round((picked.count / total) * 100)}% of all tries)` : ''}. {tone(picked.from) === 'bad' ? 'These did not reach the pass mark.' : tone(picked.from) === 'warn' ? 'These passed, with room to improve.' : 'These were strong reports.'}</>}
      </DetailLine>
    </div>
  );
}

/** Average score per day. Hover for a crosshair, click to pin a day. Days with no tries are skipped, not drawn as zero. */
export function TrendLine({ points }) {
  const useTipWidth = useTip();
  const { boxRef, show, hide, node } = useTipWidth;
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const { width } = useTipWidth;
  const W = width, H = 180, L = 30, R = 14, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const n = points.length;
  const xAt = (i) => L + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  const yAt = (v) => T + ph - (v / 100) * ph;
  const data = points.map((p, i) => ({ ...p, i })).filter(p => p.avg !== null);

  const line = data.map((p, k) => `${k ? 'L' : 'M'}${xAt(p.i)},${yAt(p.avg)}`).join(' ');
  const area = data.length > 1 ? `${line} L${xAt(data[data.length - 1].i)},${T + ph} L${xAt(data[0].i)},${T + ph} Z` : '';
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 110))));

  const nearest = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - r.left) / r.width) * W;
    let best = null, bd = Infinity;
    for (const p of data) { const d = Math.abs(xAt(p.i) - svgX); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const onMove = (e) => {
    const best = nearest(e);
    if (best) { setHover(best); show(e, `${formatDay(best.date)}: avg ${best.avg} (${best.count} ${best.count === 1 ? 'try' : 'tries'})`); }
  };
  const onClick = (e) => { const best = nearest(e); if (best) setPinned(p => (p?.i === best.i ? null : best)); };
  const active = pinned ?? hover;

  return (
    <div className="chart-box" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Average attempt score per day">
        <g className="axis">
          {[0, 50, 100].map(t => (
            <g key={t}><line className="gridline" x1={L} x2={W - R} y1={yAt(t)} y2={yAt(t)} /><text x={L - 6} y={yAt(t) + 4} textAnchor="end">{t}</text></g>
          ))}
          {points.map((p, i) => (i % labelEvery === 0 ? <text key={p.date} x={xAt(i)} y={H - 10} textAnchor="middle">{formatDay(p.date)}</text> : null))}
        </g>
        <line x1={L} x2={W - R} y1={yAt(PASS_THRESHOLD)} y2={yAt(PASS_THRESHOLD)} stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="4 3" />
        <text x={W - R} y={yAt(PASS_THRESHOLD) + 14} textAnchor="end" fontSize="11" fontWeight="700" fill="var(--ink-2)">Pass {PASS_THRESHOLD}</text>
        {area && <path d={area} fill="var(--accent-strong)" opacity="0.1" />}
        {line && <path d={line} fill="none" stroke="var(--accent-strong)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {active && <line x1={xAt(active.i)} x2={xAt(active.i)} y1={T} y2={T + ph} stroke={pinned ? 'var(--ink-2)' : 'var(--line-strong)'} strokeWidth={pinned ? 1.5 : 1} />}
        {data.map(p => (
          <circle key={p.date} className="dot" cx={xAt(p.i)} cy={yAt(p.avg)} r={active?.i === p.i ? 5 : 3.5} fill="var(--accent-strong)" stroke="var(--surface)" strokeWidth="2" />
        ))}
        <rect className="plot-hit" x={L} y={T} width={pw} height={ph} fill="transparent" onMouseMove={onMove} onMouseLeave={() => { setHover(null); hide(); }} onClick={onClick} />
      </svg>
      {node}
      <DetailLine hint="Hover to read a day, click to pin it." onClear={() => setPinned(null)}>
        {pinned && <><b>{formatDay(pinned.date)}</b>: average score {pinned.avg} from {pinned.count} {pinned.count === 1 ? 'try' : 'tries'}. {pinned.avg >= PASS_THRESHOLD ? 'Above the pass mark.' : 'Below the pass mark.'}</>}
      </DetailLine>
    </div>
  );
}

/** Horizontal bars. `colorBy="tone"` colours by score band; otherwise one accent colour. */
export function HBars({ rows, colorBy = 'accent', animate = true }) {
  return (
    <div>
      {rows.map((r, i) => <HBarRow key={r.label} row={r} index={i} colorBy={colorBy} animate={animate} />)}
    </div>
  );
}
function HBarRow({ row, index, colorBy, animate }) {
  const pct = row.max ? Math.min(100, (row.value / row.max) * 100) : 0;
  const live = useCountUp(animate ? pct : pct, { duration: 800, delay: 120 + index * 90 });
  const color = colorBy === 'tone' ? TONE_VAR[tone(row.tonePct ?? pct)] : 'var(--accent)';
  const click = row.onClick
    ? { role: 'button', tabIndex: 0, onClick: row.onClick, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.onClick(); } } }
    : {};
  return (
    <div className={`hbar-row ${row.onClick ? 'hbar-link' : ''}`} title={row.title} style={row.label ? undefined : { gridTemplateColumns: '1fr 54px' }} {...click}>
      {row.label && <span className="nm">{row.label}</span>}
      <div className="bar bar-sm" role="meter" aria-label={row.label} aria-valuenow={row.value} aria-valuemin={0} aria-valuemax={row.max}>
        <div className="bar-fill" style={{ width: `${live}%`, background: color }} />
      </div>
      <span className="vv">{row.display ?? row.value}</span>
    </div>
  );
}

/** Stacked outcome bar. Hover or click a segment or its legend item to isolate it. */
export function OutcomeStack({ outcomes }) {
  const items = [
    { key: 'passed_first_try',      label: 'Passed first try',      color: 'var(--good)',   note: 'Good enough straight away.' },
    { key: 'passed_after_revision', label: 'Passed after revising', color: 'var(--accent)', note: 'The feedback helped these get there.' },
    { key: 'in_progress',           label: 'Still in progress',     color: 'var(--track)',  note: 'The reporter has tries left.' },
    { key: 'escalated',             label: 'Escalated',             color: 'var(--bad)',    note: 'Used all tries and went to a manager.' },
  ];
  const [hot, setHot] = useState(null);     // hovered
  const [pin, setPin] = useState(null);     // clicked
  const total = items.reduce((s, it) => s + (outcomes[it.key] ?? 0), 0);
  if (total === 0) return <p className="muted">No reports in this range.</p>;
  const focus = pin ?? hot;
  const pct = (k) => Math.round(((outcomes[k] ?? 0) / total) * 100);
  const toggle = (k) => setPin(p => (p === k ? null : k));
  const picked = items.find(i => i.key === pin);

  return (
    <div>
      <div className="stack" role="group" aria-label="How reports ended">
        {items.filter(it => outcomes[it.key] > 0).map(it => (
          <button
            key={it.key} className={`seg-block ${focus && focus !== it.key ? 'dim' : ''}`} style={{ flexGrow: outcomes[it.key], background: it.color }}
            aria-pressed={pin === it.key} aria-label={`${it.label}: ${outcomes[it.key]}`} title={`${it.label}: ${outcomes[it.key]}`}
            onMouseEnter={() => setHot(it.key)} onMouseLeave={() => setHot(null)} onClick={() => toggle(it.key)}
          />
        ))}
      </div>
      <div className="legend">
        {items.map(it => (
          <button
            key={it.key} className={`legend-btn ${focus === it.key ? 'on' : ''} ${focus && focus !== it.key ? 'dim' : ''}`}
            onMouseEnter={() => setHot(it.key)} onMouseLeave={() => setHot(null)} onClick={() => toggle(it.key)} aria-pressed={pin === it.key}
          >
            <i className="swatch" style={{ background: it.color }} />{it.label} <b>{outcomes[it.key] ?? 0}</b>
            <span className="muted">({pct(it.key)}%)</span>
          </button>
        ))}
      </div>
      <DetailLine hint="Click a colour to focus on one group." onClear={() => setPin(null)}>
        {picked && <><b>{picked.label}</b>: {outcomes[picked.key]} of {total} reports ({pct(picked.key)}%). {picked.note}</>}
      </DetailLine>
    </div>
  );
}
