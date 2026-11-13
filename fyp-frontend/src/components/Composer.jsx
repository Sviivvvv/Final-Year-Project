import { useEffect, useRef } from 'react';
import { Send, RefreshCw, Loader2, Lock } from 'lucide-react';
import { SECTIONS } from '../lib/format.js';
import { StepDot } from './Messages.jsx';

const MAX_CHARS = 2000;

function AutoTextarea({ value, onChange, disabled, placeholder, rows, autoFocus }) {
  const ref = useRef(null);
  // Focus without letting the browser scroll the hero heading out of view.
  useEffect(() => { if (autoFocus) ref.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 280) + 'px';
  }, [value]);
  return (
    <textarea
      ref={ref} className="textarea" rows={rows} value={value} disabled={disabled}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value.slice(0, MAX_CHARS))}
    />
  );
}

/**
 * The three-field "message box". Used for the first submission and, pre-filled,
 * for every revision. Ctrl/Cmd + Enter sends.
 */
export default function Composer({
  fields, setFields, onSubmit, loading = false, missing = [],
  title = 'Write up the bug', subtitle, submitLabel = 'Get my score', revise = false, autoFocus = false,
}) {
  const ready = SECTIONS.every(s => fields[s.key].trim().length > 0);

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && ready && !loading) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <form className="card composer" onKeyDown={onKeyDown} onSubmit={e => { e.preventDefault(); if (ready && !loading) onSubmit(); }}>
      <div className="composer-head">
        <h3>{title}</h3>
        {subtitle && <span className="muted" style={{ fontSize: 13 }}>{subtitle}</span>}
      </div>

      {SECTIONS.map((s, i) => {
        const isMissing = missing.includes(s.code);
        return (
          <div className="field-block" key={s.key}>
            <div className="field-top">
              <StepDot s={s} />
              <b>{s.label}</b>
              <span className="hint">{s.hint}</span>
              {isMissing && <span className="chip chip-bad" style={{ marginLeft: 'auto' }}>Missing</span>}
            </div>
            <div className={`field-wrap ${isMissing ? 'is-missing' : ''}`}>
              <AutoTextarea
                value={fields[s.key]} rows={s.rows} disabled={loading} placeholder={s.placeholder}
                autoFocus={autoFocus && i === 0}
                onChange={v => setFields(prev => ({ ...prev, [s.key]: v }))}
              />
              <span className="count">{fields[s.key].length} / {MAX_CHARS}</span>
            </div>
          </div>
        );
      })}

      <div className="composer-foot">
        <span className="note"><Lock size={13} aria-hidden="true" />Only used to score your report. Ctrl + Enter sends.</span>
        <span className="grow" />
        <button className="btn btn-primary" type="submit" disabled={!ready || loading}>
          {loading
            ? <><Loader2 size={16} className="spin" aria-hidden="true" />Scoring...</>
            : <>{revise ? <RefreshCw size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}{submitLabel}</>}
        </button>
      </div>
    </form>
  );
}
