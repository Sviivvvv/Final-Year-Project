import { useCountUp } from '../lib/hooks.js';
import { tone, TONE_VAR, TONE_LABEL, PASS_THRESHOLD } from '../lib/format.js';

const clampScore = (n) => Math.max(0, Math.min(100, Number(n) || 0));

/**
 * Animated score ring. The arc and the number count up together and the arc
 * colour follows the value as it fills (red below 60, amber 60-79, green 80+).
 * The unfilled part is hatched so "how much is left" is obvious, and the
 * tick marks the pass mark.
 */
export default function ScoreRing({ score, size = 170 }) {
  const target = clampScore(score);
  const value = useCountUp(target, { duration: 1500 });
  const live = tone(value);
  const final = tone(target);

  const r = 70, c = 2 * Math.PI * r, band = 18;
  const dash = (value / 100) * c;
  const tickAngle = (PASS_THRESHOLD / 100) * 2 * Math.PI - Math.PI / 2;
  const tx = (rad) => 100 + rad * Math.cos(tickAngle);
  const ty = (rad) => 100 + rad * Math.sin(tickAngle);

  return (
    <div className="ring-wrap">
      <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={`Score ${target} out of 100, ${TONE_LABEL[final]}`}>
        <defs>
          <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="7" height="7" fill="var(--surface)" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-strong)" strokeWidth="3" />
          </pattern>
        </defs>
        <circle cx="100" cy="100" r={r} fill="none" stroke="var(--edge)" strokeWidth={band + 6} />
        <circle cx="100" cy="100" r={r} fill="none" stroke="url(#hatch)" strokeWidth={band} />
        <circle
          cx="100" cy="100" r={r} fill="none" stroke={TONE_VAR[live]} strokeWidth={band}
          strokeDasharray={`${dash} ${c}`} transform="rotate(-90 100 100)"
        />
        <line x1={tx(r - band / 2 - 4)} y1={ty(r - band / 2 - 4)} x2={tx(r + band / 2 + 6)} y2={ty(r + band / 2 + 6)} stroke="var(--edge)" strokeWidth="4" />
        <text x={tx(r + band / 2 + 18)} y={ty(r + band / 2 + 18) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--ink-2)">{PASS_THRESHOLD}</text>
        <text className="ring-num" x="100" y="110" textAnchor="middle" fontSize="50">{Math.round(value)}</text>
        <text className="ring-den" x="100" y="132" textAnchor="middle">out of 100</text>
      </svg>
      <span className="ring-sub">The line marks the pass mark ({PASS_THRESHOLD})</span>
    </div>
  );
}

/** Small static dial for lists and cards (no animation). */
export function MiniDial({ score, size = 54 }) {
  if (score === null || score === undefined) {
    return <div className="mini-dial none" style={{ width: size, height: size }} title="Not scored"><span>-</span></div>;
  }
  const v = clampScore(score);
  const r = 40, c = 2 * Math.PI * r;
  return (
    <div className="mini-dial" style={{ width: size, height: size }} title={`${v} out of 100`}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--edge)" strokeWidth="16" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--track)" strokeWidth="11" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={TONE_VAR[tone(v)]} strokeWidth="11" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <span>{Math.round(v)}</span>
    </div>
  );
}
