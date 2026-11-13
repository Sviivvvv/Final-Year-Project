/**
 * routes/admin.js — Admin-only user management and system status.
 *
 *   GET   /admin/users            list accounts (never returns password hashes)
 *   POST  /admin/users            create an account
 *   PATCH /admin/users/:email     change role / active flag / reset password
 *   GET   /admin/system           health of MongoDB, Component 1, Component 2 + counters
 *
 * Accounts are never deleted, only deactivated, so the reports a person
 * submitted keep a valid owner. Deactivating, changing the role of, or
 * resetting the password for an account signs that account out immediately.
 */

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { getDb } = require('../db');
const { computeManagerStats } = require('../services/analytics');
const { ROLES, requireRole, hashPassword, revokeTokensFor, normEmail } = require('../middleware/auth');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const startedAt = Date.now();

router.use(requireRole('admin'));

const publicUser = ({ password_hash, _id, ...rest }) => rest;

router.get('/users', wrap(async (req, res) => {
  const db    = await getDb();
  const users = await db.collection('users').find({}).sort({ created_at: 1 }).toArray();
  return res.status(200).json({ users: users.map(publicUser) });
}));

router.post('/users', wrap(async (req, res) => {
  const email = normEmail(req.body?.email);
  const { password, role } = req.body ?? {};

  if (!EMAIL_RE.test(email))          return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!ROLES.includes(role))          return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}.` });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const db = await getDb();
  if (await db.collection('users').findOne({ email })) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const user = {
    email, role,
    password_hash: hashPassword(password),
    active:        true,
    created_at:    new Date().toISOString(),
    created_by:    req.user.email,
    last_login_at: null,
  };
  await db.collection('users').insertOne(user);
  return res.status(201).json({ user: publicUser(user) });
}));

router.patch('/users/:email', wrap(async (req, res) => {
  const email = normEmail(req.params.email);
  const { role, active, password } = req.body ?? {};
  const db    = await getDb();
  const users = db.collection('users');

  const target = await users.findOne({ email });
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const set = {};
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}.` });
    set.role = role;
  }
  if (active !== undefined) {
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
    set.active = active;
  }
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    set.password_hash = hashPassword(password);
  }
  if (Object.keys(set).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  // Never leave the system without an active admin (or lock yourself out).
  const losesAdmin = target.role === 'admin' && target.active !== false &&
    ((set.role && set.role !== 'admin') || set.active === false);
  if (losesAdmin) {
    if (email === req.user.email) {
      return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    }
    const otherAdmins = await users.countDocuments({ role: 'admin', active: true, email: { $ne: email } });
    if (otherAdmins === 0) {
      return res.status(400).json({ error: 'At least one active admin account is required.' });
    }
  }

  await users.updateOne({ email }, { $set: set });
  if (set.role !== undefined || set.active === false || set.password_hash) revokeTokensFor(email);

  const updated = await users.findOne({ email });
  return res.status(200).json({ user: publicUser(updated) });
}));

router.get('/managers', wrap(async (req, res) => {
  const db = await getDb();
  const [escalated, managerUsers] = await Promise.all([
    db.collection('reports').find({ escalated: true }).project({
      thread_id: 1, observed_behavior: 1, user_email: 1, submitted_at: 1, manager_review: 1,
    }).toArray(),
    db.collection('users').find({ role: 'manager' }).toArray(),
  ]);
  const stats = computeManagerStats(escalated, managerUsers.map(u => u.email));
  const active = new Map(managerUsers.map(u => [u.email, u.active !== false]));
  stats.managers = stats.managers.map(m => ({ ...m, active: active.get(m.email) ?? false, is_manager: active.has(m.email) }));
  return res.status(200).json(stats);
}));

async function ping(url) {
  const t0 = Date.now();
  try {
    await axios.get(url, { timeout: 4000 });
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latency_ms: null, error: err.code ?? err.message };
  }
}

router.get('/system', wrap(async (req, res) => {
  const db = await getDb();
  const c1Url = process.env.COMPONENT1_URL || 'http://127.0.0.1:8000';
  const c2Url = process.env.COMPONENT2_URL || 'http://127.0.0.1:8002';

  const t0 = Date.now();
  let database;
  try {
    await db.command({ ping: 1 });
    database = { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    database = { ok: false, latency_ms: null, error: err.message };
  }

  const [component1, component2] = await Promise.all([ping(`${c1Url}/health`), ping(`${c2Url}/health`)]);

  const [users, attempts, escalatedOpen] = await Promise.all([
    db.collection('users').countDocuments({}),
    db.collection('reports').countDocuments({}),
    db.collection('reports').countDocuments({ escalated: true, manager_review: { $exists: false } }),
  ]);

  return res.status(200).json({
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    services: {
      database,
      component1: { ...component1, url: c1Url },
      component2: { ...component2, url: c2Url },
    },
    counts: { users, attempts, escalated_open: escalatedOpen },
    config: { pass_threshold: 60, max_attempts: 3, model_c2: 'gemini-3.1-flash-lite' },
  });
}));

module.exports = router;
