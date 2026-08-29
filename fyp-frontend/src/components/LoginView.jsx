/**
 * LoginView.jsx — single unified login (email + password).
 *
 * No role selector -- the backend determines role from which account
 * matched, so the same form works for both QA and Manager. No accounts UI,
 * no signup, no password reset; two fixed accounts set server-side.
 */

import { useState } from 'react';
import { Mail, KeyRound, AlertTriangle, Loader2, Bug } from 'lucide-react';

export default function LoginView({ onLoginSuccess }) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Login failed.');
        return;
      }
      onLoginSuccess(data.token, data.role, data.email ?? email);
    } catch (err) {
      setError('Could not reach the server. Make sure the backend is running on localhost:3000.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-indigo-100 p-2.5 rounded-xl">
            <Bug className="text-indigo-500 w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Sign In</h1>
            <p className="text-slate-400 text-sm mt-0.5">Bug Report Quality Assessment</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          {error && (
            <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <label className="block text-sm font-semibold text-slate-700 mb-2">Email</label>
          <div className="relative mb-4">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={loading}
              autoFocus
              autoComplete="username"
              className="w-full border border-slate-200 rounded-xl pl-10 pr-3.5 py-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-slate-50 transition-colors"
            />
          </div>

          <label className="block text-sm font-semibold text-slate-700 mb-2">Password</label>
          <div className="relative mb-5">
            <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              autoComplete="current-password"
              className="w-full border border-slate-200 rounded-xl pl-10 pr-3.5 py-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-slate-50 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-all duration-150 shadow-sm hover:shadow-md active:scale-95"
          >
            {loading ? (<><Loader2 className="w-4 h-4 animate-spin" />Signing in...</>) : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
