/**
 * RoleBadge.jsx — small, modern pill showing which role is currently
 * logged in. Reused in both App.jsx (QA) and ManagerView.jsx (Manager)
 * headers, matching the same pill style already used for PASS/FAIL and
 * status labels elsewhere in the app.
 */

import { Bug, ShieldAlert } from 'lucide-react';

const ROLE_STYLES = {
  qa: {
    label:     'QA',
    Icon:      Bug,
    className: 'bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-200',
  },
  manager: {
    label:     'Manager',
    Icon:      ShieldAlert,
    className: 'bg-red-50 text-red-600 ring-1 ring-inset ring-red-200',
  },
};

export default function RoleBadge({ role }) {
  const cfg = ROLE_STYLES[role] ?? {
    label: role, Icon: Bug, className: 'bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 ${cfg.className} text-xs font-semibold px-3 py-1.5 rounded-full`}>
      <cfg.Icon className="w-3.5 h-3.5" />
      {cfg.label}
    </span>
  );
}
