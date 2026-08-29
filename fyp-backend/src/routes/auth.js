/**
 * routes/auth.js
 *
 * POST /auth/login  — exchange an email + password for a bearer token.
 *                      Role is determined server-side from which account
 *                      matched (no role field in the request).
 * POST /auth/logout — invalidate a token.
 */

const express = require('express');
const router  = express.Router();
const { login, logout } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }
  try {
    const { token, role } = login(email, password);
    return res.status(200).json({ token, role, email });
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

module.exports = router;
