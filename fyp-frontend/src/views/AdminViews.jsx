import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus, AlertTriangle, KeyRound, Loader2, CheckCircle2, XCircle, RefreshCw, Database, Cpu, Sparkles, ChevronRight,
} from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import { formatDateTime, fmtHours, waitTone, displayName, initials, timeAgo, refId } from '../lib/format.js';
import { StatTile } from '../components/Charts.jsx';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function SpeedChip({ hours }) {
  if (hours === null || hours === undefined) return <span className="chip chip-quiet">No decisions yet</span>;
  const t = waitTone(hours);
  const label = { good: 'Fast', warn: 'Okay', bad: 'Slow' }[t];
  return <span className={`chip chip-${t}`}>{label} · {fmtHours(hours)}</span>;
}

export function TeamView() {
  const { api, navigate } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api('/admin/managers');
      if (res.status === 200) { setData(res.data); setError(null); } else setError(res.data?.error ?? 'Could not load manager activity.');
    } catch { setError('Could not reach the server.'); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const team = data?.team;
  let summary = '';
  if (team) {
    summary = team.waiting === 0
      ? 'Nothing is waiting for a decision right now.'
      : `${plural(team.waiting, 'report is', 'reports are')} waiting for a decision. The longest has waited ${fmtHours(team.oldest_waiting_hours)}.`;
    if (team.avg_turnaround_hours !== null) summary += ` Managers take ${fmtHours(team.avg_turnaround_hours)} on average to decide.`;
  }

  return (
    <div className="scroll">
      <div className="col col-wide">
        <div className="page-head">
          <div className="grow"><h2>Managers</h2><p>How quickly and how consistently escalated reports get a decision.</p></div>
          <button className="btn btn-sm" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} aria-hidden="true" />Refresh</button>
        </div>
        {error && <div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 240 }} />}

        {data && (
          <>
            <div className="panel headline"><p>{summary}</p></div>
            <div className="tiles tiles-4">
              <StatTile hero label="Waiting now" value={team.waiting} sub={team.waiting ? `Oldest: ${fmtHours(team.oldest_waiting_hours)}` : 'All clear'} />
              <StatTile label="Average time to decide" value={fmtHours(team.avg_turnaround_hours)} sub="from escalation to decision" />
              <StatTile label="Decisions, last 30 days" value={team.reviewed_30d} sub={`${team.reviewed} in total`} />
              <StatTile label="Accepted as is" value={team.accepted_rate === null ? '-' : Math.round(team.accepted_rate)} unit={team.accepted_rate === null ? '' : '%'} sub="the rest were sent back" />
            </div>

            <h3 className="section-title">Each manager</h3>
            <div className="tlist">
              {data.managers.length === 0 && <div className="empty"><p>No manager accounts yet. Add one from Users.</p></div>}
              {data.managers.map(m => {
                const total = m.accepted + m.needs_rework;
                return (
                  <div className="mgr mgr-row" key={m.email}>
                    <span className="avatar">{initials(m.email)}</span>
                    <div className="who mgr-who">
                      <b>{displayName(m.email)}</b><span>{m.email}</span>
                      {!m.active && m.is_manager && <span className="chip chip-bad" style={{ marginTop: 4 }}>Account disabled</span>}
                      {!m.is_manager && <span className="chip chip-quiet" style={{ marginTop: 4 }}>No longer a manager</span>}
                    </div>
                    <div className="mgr-stat"><b>{m.reviews}</b><span>decisions</span><small>{m.reviews_30d} in 30 days</small></div>
                    <div className="mgr-stat"><SpeedChip hours={m.avg_turnaround_hours} /><span>response time</span></div>
                    <div className="mgr-split">
                      {total === 0 ? <span className="muted">No decisions yet</span> : (
                        <>
                          <div className="stack stack-sm" role="img" aria-label={`${m.accepted} accepted, ${m.needs_rework} sent back`}>
                            {m.accepted > 0 && <div style={{ flexGrow: m.accepted, background: 'var(--good)' }} />}
                            {m.needs_rework > 0 && <div style={{ flexGrow: m.needs_rework, background: 'var(--accent)' }} />}
                          </div>
                          <div className="legend" style={{ marginTop: 6 }}>
                            <span><i className="swatch" style={{ background: 'var(--good)' }} />Accepted <b>{m.accepted}</b></span>
                            <span><i className="swatch" style={{ background: 'var(--accent)' }} />Sent back <b>{m.needs_rework}</b></span>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="mgr-stat last"><span>Last decision</span><b style={{ fontSize: 14 }}>{m.last_review_at ? timeAgo(m.last_review_at) : 'Never'}</b></div>
                  </div>
                );
              })}
            </div>

            {data.waiting.length > 0 && (
              <>
                <h3 className="section-title">Waiting the longest</h3>
                <div className="tlist">
                  {data.waiting.map(w => (
                    <button className="trow trow-slim urgent" key={w.thread_id} onClick={() => navigate(`reports/open/${w.thread_id}`)}>
                      <div className="trow-main">
                        <span className="t-ref mono">{refId(w.thread_id)}</span>
                        <span className="trow-title">{w.title || '(no text)'}</span>
                      </div>
                      <span className="who-chip trow-who"><span className="avatar avatar-xs">{initials(w.user_email ?? '')}</span>{displayName(w.user_email ?? 'unknown')}</span>
                      <span className={`chip chip-${waitTone(w.waiting_hours)}`}>Waiting {fmtHours(w.waiting_hours)}</span>
                      <ChevronRight size={17} className="muted" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const ROLE_LABEL = { qa: 'QA tester', manager: 'Manager', admin: 'Admin' };

function ResetRow({ email, onDone }) {
  const { api, toast } = useApp();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const res = await api(`/admin/users/${encodeURIComponent(email)}`, { method: 'PATCH', body: { password: pw } }).catch(() => null);
    setBusy(false);
    if (res?.status === 200) { toast('Password updated, user signed out'); onDone(); }
    else setErr(res?.data?.error ?? 'Could not update the password.');
  };
  return (
    <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
      <input className="input" type="password" style={{ maxWidth: 240 }} placeholder="New password (8+ characters)" value={pw}
        onChange={e => setPw(e.target.value)} autoComplete="new-password" aria-label={`New password for ${email}`} />
      <button className="btn btn-sm btn-primary" onClick={save} disabled={busy || pw.length < 8}>{busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : 'Save'}</button>
      <button className="btn btn-sm btn-ghost" onClick={onDone}>Cancel</button>
      {err && <span style={{ color: 'var(--bad)', fontSize: 13 }}>{err}</span>}
    </div>
  );
}

export function UsersView() {
  const { api, auth, toast } = useApp();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'qa' });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api('/admin/users');
      if (res.status === 200) { setUsers(res.data.users); setError(null); } else setError(res.data?.error ?? 'Could not load users.');
    } catch { setError('Could not reach the server.'); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const patch = async (email, body, okMsg) => {
    const res = await api(`/admin/users/${encodeURIComponent(email)}`, { method: 'PATCH', body }).catch(() => null);
    if (res?.status === 200) { toast(okMsg); load(); } else toast(res?.data?.error ?? 'Update failed');
  };

  const create = async (e) => {
    e.preventDefault();
    setCreating(true); setFormError(null);
    const res = await api('/admin/users', { method: 'POST', body: form }).catch(() => null);
    setCreating(false);
    if (res?.status === 201) { toast('User created'); setForm({ email: '', password: '', role: 'qa' }); load(); }
    else setFormError(res?.data?.error ?? 'Could not create the user.');
  };

  return (
    <div className="scroll">
      <div className="col col-wide">
        <div className="page-head">
          <div className="grow"><h2>Users</h2><p>Create accounts, change roles, disable access and reset passwords.</p></div>
        </div>

        <form className="card" style={{ padding: 16, marginBottom: 22 }} onSubmit={create}>
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Add a user</h3>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label className="label" htmlFor="nu-email">Email</label>
              <input id="nu-email" className="input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} autoComplete="off" />
            </div>
            <div style={{ flex: '1 1 190px' }}>
              <label className="label" htmlFor="nu-pw">Temporary password</label>
              <input id="nu-pw" className="input" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoComplete="new-password" />
            </div>
            <div style={{ flex: '0 1 150px' }}>
              <label className="label" htmlFor="nu-role">Role</label>
              <select id="nu-role" className="select" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={creating || !form.email || form.password.length < 8}>
              {creating ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}Create
            </button>
          </div>
          {formError && <div className="alert" style={{ marginTop: 12 }} role="alert"><AlertTriangle size={16} aria-hidden="true" />{formError}</div>}
        </form>

        {error && <div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
        <div className="tlist" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {!users && <tr><td colSpan={5}><div className="skeleton" style={{ height: 40 }} /></td></tr>}
              {users?.map(u => {
                const self = u.email === auth.email;
                return (
                  <tr key={u.email}>
                    <td>
                      <b>{u.email}</b>{self && <span className="chip chip-accent" style={{ marginLeft: 8 }}>You</span>}
                      {resetFor === u.email && <ResetRow email={u.email} onDone={() => setResetFor(null)} />}
                    </td>
                    <td>
                      <select className="select" style={{ width: 140, padding: '6px 10px' }} value={u.role} disabled={self}
                        aria-label={`Role for ${u.email}`} onChange={e => patch(u.email, { role: e.target.value }, 'Role updated')}>
                        {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td>{u.active
                      ? <span className="chip chip-good"><CheckCircle2 size={13} aria-hidden="true" />Active</span>
                      : <span className="chip chip-bad"><XCircle size={13} aria-hidden="true" />Disabled</span>}</td>
                    <td className="muted">{u.last_login_at ? formatDateTime(u.last_login_at) : 'Never'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => setResetFor(resetFor === u.email ? null : u.email)}><KeyRound size={14} aria-hidden="true" />Reset password</button>{' '}
                      {!self && (
                        <button className="btn btn-sm" onClick={() => patch(u.email, { active: !u.active }, u.active ? 'User disabled' : 'User enabled')}>
                          {u.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** One service as a health check row, styled like the QA pipeline checks. */
function Service({ icon: Icon, name, svc, detail }) {
  const ok = svc?.ok;
  return (
    <li className={`check svc-check st-${ok ? 'ok' : 'fail'}`}>
      <span className="check-ic">{ok ? <CheckCircle2 size={19} aria-hidden="true" /> : <XCircle size={19} aria-hidden="true" />}</span>
      <span className="svc-ic"><Icon size={16} aria-hidden="true" /></span>
      <div className="grow">
        <b>{name}</b>
        <small>{detail}</small>
      </div>
      <div style={{ textAlign: 'right' }}>
        <span className={`chip ${ok ? 'chip-good' : 'chip-bad'}`}>{ok ? 'Online' : 'Offline'}</span>
        <small style={{ display: 'block', marginTop: 4 }}>{ok ? `${svc.latency_ms} ms` : (svc?.error ?? 'No response')}</small>
      </div>
    </li>
  );
}

const fmtUptime = (s) => (s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

export function SystemView() {
  const { api } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api('/admin/system');
      if (res.status === 200) { setData(res.data); setError(null); } else setError(res.data?.error ?? 'Could not load system status.');
    } catch { setError('Could not reach the server.'); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  return (
    <div className="scroll">
      <div className="col col-wide">
        <div className="page-head">
          <div className="grow"><h2>System</h2><p>Live health of the services behind the platform. Refreshes every 20 seconds.</p></div>
          <button className="btn btn-sm" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} aria-hidden="true" />Refresh</button>
        </div>
        {error && <div className="alert" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}
        {!data && !error && <div className="skeleton" style={{ height: 220 }} />}
        {data && (
          <>
            <ol className="checks svc-list">
              <Service icon={Database} name="Database" svc={data.services.database} detail="MongoDB Atlas" />
              <Service icon={Cpu} name="Component 1: structure and quality classifier" svc={data.services.component1} detail={`RoBERTa-Large · ${data.services.component1.url}`} />
              <Service icon={Sparkles} name="Component 2: content scorer" svc={data.services.component2} detail={`${data.config.model_c2} · ${data.services.component2.url}`} />
            </ol>
            <div className="tiles">
              <StatTile label="Backend uptime" value={fmtUptime(data.uptime_s)} />
              <StatTile label="Accounts" value={data.counts.users} />
              <StatTile label="Stored attempts" value={data.counts.attempts} />
              <StatTile label="Awaiting review" value={data.counts.escalated_open} />
              <StatTile label="Pass mark" value={data.config.pass_threshold} unit="/ 100" sub={`${data.config.max_attempts} attempts per report`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
