import { useEffect, useRef, useState, useCallback } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Eases a number from 0 up to `target`. The ring and the dimension bars both
 * use it so colour (red -> amber -> green) can follow the value as it fills.
 */
export function useCountUp(target, { duration = 1300, delay = 0 } = {}) {
  const [value, setValue] = useState(prefersReducedMotion() ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion()) { setValue(target); return undefined; }
    let raf;
    let start = null;
    const timer = setTimeout(() => {
      const tick = (now) => {
        if (start === null) start = now;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setValue(target * eased);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [target, duration, delay]);

  return value;
}

/** Tiny hash router: '#/t/abc' -> ['t', 'abc']. A '?a=b' suffix is left for hashQuery(). */
export function hashQuery() {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '');
}

export function useHashRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);

  useEffect(() => {
    const onChange = () => setParts(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((path) => {
    const next = '#/' + String(path).replace(/^\/+/, '');
    if (window.location.hash === next) setParts(read());
    else window.location.hash = next;
  }, []);

  return [parts, navigate];
}

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  const toggle = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch { /* storage may be blocked */ }
      return next;
    });
  }, []);
  return [theme, toggle];
}

/** Keeps the latest callback without re-subscribing effects. */
export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
