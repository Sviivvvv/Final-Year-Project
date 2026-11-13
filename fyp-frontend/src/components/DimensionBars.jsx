import { useCountUp } from '../lib/hooks.js';
import { DIMENSIONS, tone, TONE_VAR } from '../lib/format.js';

function BarRow({ dim, value, index }) {
  const pct = Math.max(0, Math.min(100, (value / dim.max) * 100));
  // Staggered start so the bars fill one after another, after the ring begins.
  const live = useCountUp(pct, { duration: 1000, delay: 350 + index * 170 });
  return (
    <div className="bar-row" title={dim.hint}>
      <div className="top">
        <b>{dim.label}</b>
        <span className="val">{Math.round((live / 100) * dim.max)}<i> / {dim.max}</i></span>
      </div>
      <div className="bar" role="meter" aria-label={dim.label} aria-valuemin={0} aria-valuemax={dim.max} aria-valuenow={value}>
        <div className="bar-fill" style={{ width: `${live}%`, background: TONE_VAR[tone(live)] }} />
      </div>
      <div className="bar-hint">{dim.hint}</div>
    </div>
  );
}

/** One bar per scoring area, each filled relative to that area's own maximum. */
export default function DimensionBars({ scores = {} }) {
  const rows = DIMENSIONS.filter(d => typeof scores[d.key] === 'number');
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="bars">
        {rows.map((d, i) => <BarRow key={d.key} dim={d} value={scores[d.key]} index={i} />)}
      </div>
      <div className="legend-line" aria-hidden="true">
        <span><i className="swatch" style={{ background: 'var(--bad)' }} />weak</span>
        <span><i className="swatch" style={{ background: 'var(--warn)' }} />okay</span>
        <span><i className="swatch" style={{ background: 'var(--good)' }} />strong</span>
      </div>
    </div>
  );
}
