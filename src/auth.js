import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'crm_session';

function timingSafeEqualText(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function credentialsAreValid(email, password) {
  return timingSafeEqualText(email, process.env.ADMIN_EMAIL || '') &&
    timingSafeEqualText(password, process.env.ADMIN_PASSWORD || '');
}

export function setSession(res, email) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET não configurado');
  const token = jwt.sign({ sub: email, role: 'admin' }, secret, { expiresIn: '12h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

export function requireAuth(req, res, next) {
  try {
    const secret = process.env.SESSION_SECRET;
    const token = req.cookies?.[COOKIE_NAME];
    if (!secret || !token) return res.redirect('/login');
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    return res.redirect('/login');
  }
}
