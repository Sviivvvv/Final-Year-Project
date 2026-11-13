/**
 * middleware/auth.js
 *
 * Authentication for the MVP build: three roles (qa, manager, admin).
 *
 * Accounts live in the `users` collection (scrypt-hashed passwords). On
 * startup, accounts defined in .env (QA_*, MANAGER_*, and optionally ADMIN_*)
 * are seeded into the collection if they do not exist yet, so existing logins
 * keep working. After that the database is the source of truth: an Admin can
 * create users, change roles, deactivate accounts and reset passwords from
 * the UI, and .env values are not re-applied over those edits.
 *
 * Login exchanges email + password for an opaque bearer token. Tokens are
 * held in memory with a 12 hour expiry (single-server build, no shared
 * session store), so a backend restart signs everyone out.
 */

const crypto = require('crypto');
const { getDb } = require('../db');

const ROLES = ['qa', 'manager', 'admin'];
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Login throttle: 6 failed attempts per email+ip in 10 minutes.
const MAX_FAILS   = 6;
const FAIL_WINDOW = 10 * 60 * 1000;

// token -> { role, email, issuedAt, expiresAt }
const sessions = new Map();
// `${email}|${ip}` -> { count, first }
const failures = new Map();

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected  = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedUsers() {
  const db    = await getDb();
  const users = db.collection('users');

  const seeds = [
    { email: process.env.QA_EMAIL,      password: process.env.QA_PASSWORD,      role: 'qa' },
    { email: process.env.MANAGER_EMAIL, password: process.env.MANAGER_PASSWORD, role: 'manager' },
    { email: process.env.ADMIN_EMAIL,   password: process.env.ADMIN_PASSWORD,   role: 'admin' },
  ].filter(s => s.email && s.password);

  for (const s of seeds) {
    const email  = normEmail(s.email);
    const exists = await users.findOne({ email });
    if (exists) continue;
    await users.insertOne({
      email,
      role:          s.role,
      password_hash: hashPassword(s.password),
      active:        true,
      created_at:    new Date().toISOString(),
      created_by:    'seed',
      last_login_at: null,
    });
    console.log(`[Auth] Seeded ${s.role} account: ${email}`);
  }

  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    const hasAdmin = await users.findOne({ role: 'admin', active: true });
    if (!hasAdmin) {
      console.warn('[Auth] No active admin account. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart to create one.');
    }
  }
}

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

function throttled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW) { failures.delete(key); return false; }
  return f.count >= MAX_FAILS;
}

function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > FAIL_WINDOW) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}

async function login(rawEmail, password, ip = '') {
  const email = normEmail(rawEmail);
  const key   = `${email}|${ip}`;

  if (throttled(key)) {
    throw Object.assign(new Error('Too many failed attempts. Try again in a few minutes.'), { status: 429 });
  }

  const db   = await getDb();
  const user = await db.collection('users').findOne({ email });

  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    throw Object.assign(new Error('Incorrect email or password.'), { status: 401 });
  }

  failures.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  const now   = Date.now();
  sessions.set(token, { role: user.role, email, issuedAt: now, expiresAt: now + TOKEN_TTL_MS });
  await db.collection('users').updateOne({ email }, { $set: { last_login_at: new Date(now).toISOString() } });

  return { token, role: user.role, email };
}

function logout(token) {
  if (token) sessions.delete(token);
}

/** Drop every live session for an account (used on deactivate / role change / password reset). */
function revokeTokensFor(email) {
  const target = normEmail(email);
  for (const [token, s] of sessions) {
    if (s.email === target) sessions.delete(token);
  }
}

function sessionFor(req) {
  const header  = req.headers.authorization ?? '';
  const token   = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token ? sessions.get(token) : null;
  if (session && session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/**
 * Express middleware factory: requireRole('qa'), requireRole(['manager','admin']).
 * Sets req.user = { email, role } on success.
 */
function requireRole(roleOrRoles) {
  const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return (req, res, next) => {
    const session = sessionFor(req);
    if (!session) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (!allowed.includes(session.role)) {
      return res.status(403).json({ error: `This action requires one of these roles: ${allowed.join(', ')}.` });
    }
    req.user = { email: session.email, role: session.role };
    req.role = session.role;
    next();
  };
}

module.exports = {
  ROLES, seedUsers, login, logout, revokeTokensFor, requireRole,
  hashPassword, normEmail,
};
