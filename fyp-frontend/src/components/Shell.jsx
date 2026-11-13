import { useEffect, useMemo, useState } from 'react';
import {
  ScanSearch, PlusCircle, Search, BarChart3, Inbox, Users, Activity, UserCheck, LogOut, Sun, Moon, Menu,
  CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import { groupByRecency, initials, displayName, refId, tone } from '../lib/format.js';

const ROLE_LABEL = { qa: 'QA tester', manager: 'Manager', admin: 'Admin' };

function StatusIcon({ outcome }) {
  if (outcome === 'passed') return <CheckCircle2 className="status-ic" size={15} style={{ color: 'var(--good)' }} aria-label="Passed" />;
  if (outcome === 'escalated') return <XCircle className="status-ic" size={15} style={{ color: 'var(--bad)' }} aria-label="Escalated" />;
  return <Clock className="status-ic" size={15} style={{ color: 'var(--ink-3)' }} aria-label="In progress" />;
}

function NavItem({ icon: Icon, label, active, onClick, count }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <Icon size={17} aria-hidden="true" />{label}
      {count > 0 && <span className="nav-count" aria-label={`${count} waiting`}>{count}</span>}
    </button>
  );
}

function Sidebar({ route, onNavigate, theme, toggleTheme, onLogout, counts, threads }) {
  const { auth } = useApp();
  const [q, setQ] = useState('');
  const isQA = auth.role === 'qa';
  const section = route[0] ?? '';

  const groups = useMemo(() => {
    const list = (threads ?? []).filter(t => !q || t.title.toLowerCase().includes(q.toLowerCase()));
    return groupByRecency(list, t => t.updated_at);
  }, [threads, q]);

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="side-head">
        <div className="row">
          <div className="brand grow"><span className="logo"><ScanSearch size={18} aria-hidden="true" /></span>DaApp</div>
          <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle theme">
            {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
          </button>
        </div>
        {isQA && (
          <button className="btn btn-primary btn-block" onClick={() => onNavigate('new')}>
            <PlusCircle size={17} aria-hidden="true" />New report
          </button>
        )}
      </div>

      <nav className="nav" aria-label="Main">
        {!isQA && <NavItem icon={Inbox} label="Review queue" active={section === 'reports'} count={counts?.escalated_open} onClick={() => onNavigate('reports/open')} />}
        <NavItem icon={BarChart3} label={isQA ? 'My progress' : 'Insights'} active={section === 'insights'} onClick={() => onNavigate('insights')} />
        {auth.role === 'admin' && <NavItem icon={UserCheck} label="Managers" active={section === 'team'} onClick={() => onNavigate('team')} />}
        {auth.role === 'admin' && <NavItem icon={Users} label="Users" active={section === 'users'} onClick={() => onNavigate('users')} />}
        {auth.role === 'admin' && <NavItem icon={Activity} label="System" active={section === 'system'} onClick={() => onNavigate('system')} />}
      </nav>

      {isQA ? (
        <>
          <div className="side-search">
            <Search size={15} aria-hidden="true" />
            <input className="input" placeholder="Search your reports" value={q} onChange={e => setQ(e.target.value)} aria-label="Search your reports" />
          </div>
          <div className="hist">
            {threads === null && [0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 34, margin: '8px 4px' }} />)}
            {threads && threads.length === 0 && <p className="muted" style={{ padding: '14px 10px', fontSize: 13.5 }}>Your past reports will show up here.</p>}
            {groups.map(g => (
              <div key={g.label}>
                <div className="hist-group">{g.label}</div>
                {g.items.map(t => (
                  <button key={t.thread_id} className={`hist-item ticket ${section === 't' && route[1] === t.thread_id ? 'active' : ''}`} onClick={() => onNavigate(`t/${t.thread_id}`)} title={t.title}>
                    <StatusIcon outcome={t.outcome} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="t-ref mono">{refId(t.thread_id)} · rev {t.attempts}</span>
                      <span className="truncate" style={{ display: 'block' }}>{t.title || 'Untitled report'}</span>
                    </span>
                    {typeof t.latest_score === 'number' && <span className={`t-score tone-${tone(t.latest_score)}`}>{t.latest_score}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : <div className="hist" />}

      <div className="side-foot">
        <span className="avatar">{initials(auth.email)}</span>
        <div className="who grow">
          <b className="truncate">{displayName(auth.email)}</b>
          <span className="truncate" style={{ display: 'block' }}>{ROLE_LABEL[auth.role]}</span>
        </div>
        <button className="icon-btn" onClick={onLogout} aria-label="Log out" title="Log out"><LogOut size={18} aria-hidden="true" /></button>
      </div>
    </aside>
  );
}

const TITLES = { new: 'Report workbench', t: 'Report workbench',insights: 'Insights', reports: 'Review queue', team: 'Managers', users: 'Users', system: 'System' };

export default function Shell({ route, onNavigate, theme, toggleTheme, onLogout, children }) {
  const { api, auth, historyVersion } = useApp();
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState(null);
  const [counts, setCounts] = useState(null);

  // Sidebar data: QA gets their history; staff only need the "needs review" badge.
  useEffect(() => {
    let cancelled = false;
    const filter = auth.role === 'qa' ? 'all' : 'escalated_open';
    api(`/reports/threads?filter=${filter}`)
      .then(res => { if (!cancelled && res.status === 200) { setThreads(res.data.threads); setCounts(res.data.counts); } })
      .catch(() => { if (!cancelled) setThreads(prev => prev ?? []); });
    return () => { cancelled = true; };
  }, [api, auth.role, historyVersion]);

  useEffect(() => { setOpen(false); }, [route.join('/')]);

  const nav = (p) => { onNavigate(p); setOpen(false); };
  const title = TITLES[route[0] ?? 'new'] ?? 'DaApp';

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <Sidebar route={route} onNavigate={nav} theme={theme} toggleTheme={toggleTheme} onLogout={onLogout} counts={counts} threads={auth.role === 'qa' ? threads : null} />
      <div className="scrim" onClick={() => setOpen(false)} />
      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} aria-hidden="true" /></button>
          <h1>{title}</h1>
        </header>
        {children}
      </main>
    </div>
  );
}
