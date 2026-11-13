/**
 * routes/auth.js
 *
 * POST /auth/login  — exchange an email + password for a bearer token.
 *                      Role is determined server-side from the stored account.
 * POST /auth/logout — invalidate a token.
 * GET  /auth/me     — confirm a stored token is still valid (used on page load).
 */

const express = require('express');
const router  = express.Router();
const { login, logout, requireRole } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }
  try {
    const result = await login(email, password, req.ip);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.status ?? 500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  logout(token);
  return res.status(200).json({ status: 'logged_out' });
});

router.get('/me', requireRole(['qa', 'manager', 'admin']), (req, res) => {
  return res.status(200).json(req.user);
});

module.exports = router;
