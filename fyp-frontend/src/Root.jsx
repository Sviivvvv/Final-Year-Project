/**
 * Root.jsx - auth, theme, hash routing and the role-based shell.
 *
 *   QA tester : #/new, #/t/<threadId>, #/insights
 *   Manager   : #/reports/<open|reviewed|all>[/<threadId>], #/insights
 *   Admin     : everything a manager has, plus #/users and #/system
 *
 * One login for everyone; the role comes back from the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext } from './lib/app-context.js';
import { useHashRoute, useTheme } from './lib/hooks.js';
import LoginView from './components/LoginView.jsx';
import Shell from './components/Shell.jsx';
import Workbench from './views/Workbench.jsx';
import InsightsView from './views/InsightsView.jsx';
import ReportsView from './views/ReportsView.jsx';
import { UsersView, SystemView, TeamView } from './views/AdminViews.jsx';

function loadAuth() {
  try {
    const raw = localStorage.getItem('auth');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const DEFAULT_ROUTE = { qa: 'new', manager: 'reports/open', admin: 'insights' };

export default function Root() {
  const [auth, setAuth] = useState(loadAuth);
  const [route, navigate] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [toastMsg, setToastMsg] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const toastTimer = useRef(null);

  const clearAuth = useCallback(() => {
    try { localStorage.removeItem('auth'); } catch { /* ignore */ }
    setAuth(null);
  }, []);

  const handleLoginSuccess = (token, role, email) => {
    const next = { token, role, email };
    try { localStorage.setItem('auth', JSON.stringify(next)); } catch { /* ignore */ }
    setAuth(next);
    navigate(DEFAULT_ROUTE[role] ?? 'new');
  };

  const handleLogout = useCallback(async () => {
    if (auth?.token) {
      try { await fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}` } }); } catch { /* best effort */ }
    }
    clearAuth();
  }, [auth, clearAuth]);

  const token = auth?.token;
  const api = useCallback(async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    // Expired / revoked session: drop back to the login screen.
    if (res.status === 401) clearAuth();
    return { status: res.status, data };
  }, [token, clearAuth]);

  // A stored token may have expired (backend restart, 12h expiry, account disabled).
  useEffect(() => {
    if (token) api('/auth/me').catch(() => { /* offline: keep the session, calls will report errors */ });
  }, [token, api]);

  const toast = useCallback((msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2200);
  }, []);
  const refreshHistory = useCallback(() => setHistoryVersion(v => v + 1), []);

  // Keep the URL valid for the signed-in role.
  const role = auth?.role;
  useEffect(() => {
    if (!role) return;
    const [first] = route;
    const staff = role !== 'qa';
    const valid =
      (role === 'qa' && (!first || first === 'new' || first === 't' || first === 'insights')) ||
      (staff && (first === 'reports' || first === 'insights')) ||
      (role === 'admin' && (first === 'users' || first === 'system' || first === 'team'));
    if (!valid) {
      // Old QA-style links opened by staff map onto the review page.
      if (staff && first === 't' && route[1]) navigate(`reports/all/${route[1]}`);
      else navigate(DEFAULT_ROUTE[role]);
    }
  }, [role, route, navigate]);

  const ctx = useMemo(
    () => ({ auth, api, navigate, toast, refreshHistory, historyVersion }),
    [auth, api, navigate, toast, refreshHistory, historyVersion],
  );

  if (!auth) return <LoginView onLoginSuccess={handleLoginSuccess} />;

  const [first, second, third] = route;
  let view;
  if (first === 'insights') view = <InsightsView />;
  else if (first === 'reports' && role !== 'qa') view = <ReportsView tab={second || 'open'} threadId={third} />;
  else if (first === 'team' && role === 'admin') view = <TeamView />;
  else if (first === 'users' && role === 'admin') view = <UsersView />;
  else if (first === 'system' && role === 'admin') view = <SystemView />;
  else if (role === 'qa') view = <Workbench key={first === 't' ? second : 'new'} threadId={first === 't' ? second : null} />;
  else view = null;

  return (
    <AppContext.Provider value={ctx}>
      <Shell route={route} onNavigate={navigate} theme={theme} toggleTheme={toggleTheme} onLogout={handleLogout}>
        {view}
      </Shell>
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </AppContext.Provider>
  );
}
