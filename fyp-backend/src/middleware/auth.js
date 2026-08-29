/**
 * middleware/auth.js
 *
 * Two-account authentication gate (QA Tester, Manager) for the Mid-Point
 * build.
 *
 * Two fixed accounts (email + password), set via .env, each mapped to a
 * role. Login exchanges the correct email/password pair for an opaque
 * bearer token. Tokens are held in memory only and reset when the backend
 * restarts, since this is a single-server build with no persistent session
 * store yet. Admin-role support and user management/registration are not
 * yet implemented.
 */

const crypto = require('crypto');

// token -> { role, email, issuedAt }
const activeTokens = new Map();

const ACCOUNTS = {
  [process.env.QA_EMAIL]:      { password: process.env.QA_PASSWORD,      role: 'qa' },
  [process.env.MANAGER_EMAIL]: { password: process.env.MANAGER_PASSWORD, role: 'manager' },
};

function login(email, password) {
  const account = ACCOUNTS[email];
  if (!account || password !== account.password) {
    throw Object.assign(new Error('Incorrect email or password.'), { status: 401 });
  }
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, { role: account.role, email, issuedAt: Date.now() });
  return { token, role: account.role };
}

function logout(token) {
  if (token) activeTokens.delete(token);
}

/**
 * Express middleware factory -- requireRole('qa'), requireRole('manager'),
 * or requireRole(['qa', 'manager']) for a route both roles may access.
 * Reads `Authorization: Bearer <token>`, checks it against the in-memory
 * token store, and rejects if missing/invalid/wrong role.
 */
function requireRole(roleOrRoles) {
  const allowed = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  return (req, res, next) => {
    const header  = req.headers.authorization ?? '';
    const token   = header.startsWith('Bearer ') ? header.slice(7) : null;
    const session = token ? activeTokens.get(token) : null;

    if (!session) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (!allowed.includes(session.role)) {
      return res.status(403).json({ error: `This action requires one of these roles: ${allowed.join(', ')}.` });
    }
    req.role = session.role;
    next();
  };
}

module.exports = { login, logout, requireRole };