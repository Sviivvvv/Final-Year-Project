import { useState } from 'react';
import { Mail, KeyRound, AlertTriangle, Loader2, ScanSearch, ArrowRight } from 'lucide-react';

export default function LoginView({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? 'Login failed.'); return; }
      onLoginSuccess(data.token, data.role, data.email ?? email);
    } catch {
      setError('Could not reach the server. Make sure the backend is running.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <span className="blob b1" aria-hidden="true" />
      <span className="blob b2" aria-hidden="true" />
      <span className="blob b3" aria-hidden="true" />

      <form className="card login-card" onSubmit={handleSubmit}>
        <div className="brand" style={{ marginBottom: 6 }}>
          <span className="logo"><ScanSearch size={18} aria-hidden="true" /></span>
          DaApp
        </div>
        <h1 style={{ fontSize: 26, margin: '14px 0 4px' }}>Sign in</h1>
        <p className="muted" style={{ marginBottom: 20 }}>Check the quality of a bug report before it reaches a developer.</p>

        {error && <div className="alert" style={{ marginBottom: 16 }} role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}

        <label className="label" htmlFor="email">Email</label>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <Mail size={16} aria-hidden="true" style={{ position: 'absolute', left: 12, top: 13, color: 'var(--ink-3)' }} />
          <input id="email" className="input" style={{ paddingLeft: 38 }} type="email" value={email} autoFocus
            autoComplete="username" disabled={loading} onChange={e => setEmail(e.target.value)} />
        </div>

        <label className="label" htmlFor="password">Password</label>
        <div style={{ position: 'relative', marginBottom: 20 }}>
          <KeyRound size={16} aria-hidden="true" style={{ position: 'absolute', left: 12, top: 13, color: 'var(--ink-3)' }} />
          <input id="password" className="input" style={{ paddingLeft: 38 }} type="password" value={password}
            autoComplete="current-password" disabled={loading} onChange={e => setPassword(e.target.value)} />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={loading || !email || !password}>
          {loading ? <><Loader2 size={16} className="spin" aria-hidden="true" />Signing in...</> : <>Sign in<ArrowRight size={16} aria-hidden="true" /></>}
        </button>
      </form>
    </div>
  );
}
