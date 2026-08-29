/**
 * Root.jsx — single unified login, routed by account role (not by URL).
 *
 * One login screen for everyone. Which view renders afterward (QA
 * submission flow or Manager escalated-reports list) is decided entirely by
 * which account matched on the backend -- no more /manager URL to remember
 * or switch to manually.
 */

import { useState } from 'react';
import App from './App.jsx';
import ManagerView from './components/ManagerView.jsx';
import LoginView from './components/LoginView.jsx';

function loadAuth() {
  try {
    const raw = localStorage.getItem('auth');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function Root() {
  const [auth, setAuth] = useState(loadAuth());

  const handleLoginSuccess = (token, role, email) => {
    const next = { token, role, email };
    localStorage.setItem('auth', JSON.stringify(next));
    setAuth(next);
  };

  const handleLogout = async () => {
    try {
      await fetch('/auth/logout', {
        method:  'POST',
        headers: { Authorization: `Bearer ${auth?.token}` },
      });
    } catch {
      // Logout is best-effort server-side (token just expires from memory on
      // restart anyway) -- always clear local state regardless of the call.
    }
    localStorage.removeItem('auth');
    setAuth(null);
  };

  if (!auth) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return auth.role === 'manager'
    ? <ManagerView token={auth.token} role={auth.role} email={auth.email} onLogout={handleLogout} />
    : <App token={auth.token} role={auth.role} email={auth.email} onLogout={handleLogout} />;
}
