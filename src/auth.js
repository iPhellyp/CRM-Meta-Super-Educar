import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'crm_session';
const CSRF_COOKIE_NAME = 'crm_csrf';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 32;

function timingSafeEqualText(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
  };
}

function parsePasswordHash(encoded) {
  const [algorithm, costText, blockSizeText, parallelizationText, saltHex, hashHex] =
    String(encoded || '').split('$');
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    algorithm !== 'scrypt' ||
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelization) ||
    cost < 16_384 ||
    cost > 262_144 ||
    (cost & (cost - 1)) !== 0 ||
    blockSize !== 8 ||
    parallelization !== 1 ||
    !/^[a-f0-9]{32,}$/i.test(saltHex || '') ||
    !/^[a-f0-9]{64}$/i.test(hashHex || '')
  ) {
    return null;
  }
  return {
    cost,
    blockSize,
    parallelization,
    salt: Buffer.from(saltHex, 'hex'),
    hash: Buffer.from(hashHex, 'hex'),
  };
}

function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  const parameters = parsed || {
    cost: 16_384,
    blockSize: 8,
    parallelization: 1,
    salt: Buffer.alloc(16),
    hash: Buffer.alloc(SCRYPT_KEY_LENGTH),
  };
  let calculated;
  try {
    calculated = crypto.scryptSync(String(password), parameters.salt, parameters.hash.length, {
      N: parameters.cost,
      r: parameters.blockSize,
      p: parameters.parallelization,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return Boolean(parsed) && crypto.timingSafeEqual(calculated, parameters.hash);
}

function csrfSignature(nonce) {
  const secret = process.env.SESSION_SECRET || '';
  return crypto.createHmac('sha256', secret).update(nonce).digest('hex');
}

function csrfTokenIsValid(token) {
  const [nonce, signature] = String(token || '').split('.');
  if (!/^[a-f0-9]{64}$/i.test(nonce || '') || !/^[a-f0-9]{64}$/i.test(signature || '')) {
    return false;
  }
  return timingSafeEqualText(signature, csrfSignature(nonce));
}

export function credentialsAreValid(email, password) {
  const emailValid = timingSafeEqualText(
    String(email).trim().toLowerCase(),
    String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  );
  const passwordValid = verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  return emailValid && passwordValid;
}

export function validateAuthConfig() {
  const errors = [];
  if (!process.env.ADMIN_EMAIL) errors.push('ADMIN_EMAIL');
  if (!parsePasswordHash(process.env.ADMIN_PASSWORD_HASH)) errors.push('ADMIN_PASSWORD_HASH');
  if (Buffer.byteLength(process.env.SESSION_SECRET || '', 'utf8') < 64) {
    errors.push('SESSION_SECRET com pelo menos 64 bytes');
  }
  if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'true') {
    errors.push('COOKIE_SECURE=true');
  }
  if (errors.length) {
    throw new Error(`Configuração de autenticação inválida: ${errors.join(', ')}`);
  }
}

export function setSession(res, email) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET não configurado');
  const token = jwt.sign({ sub: email, role: 'admin' }, secret, {
    algorithm: 'HS256',
    audience: 'crm-meta-panel',
    issuer: 'crm-meta-bridge',
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
  res.cookie(COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.clearCookie(CSRF_COOKIE_NAME, cookieOptions());
}

export function issueCsrfToken(req, res) {
  const current = req.cookies?.[CSRF_COOKIE_NAME];
  if (csrfTokenIsValid(current)) return current;
  const nonce = crypto.randomBytes(32).toString('hex');
  const token = `${nonce}.${csrfSignature(nonce)}`;
  res.cookie(CSRF_COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: SESSION_MAX_AGE_MS,
  });
  return token;
}

export function requireCsrf(req, res, next) {
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const submittedToken = req.body?._csrf || req.get('x-csrf-token');
  if (
    !csrfTokenIsValid(cookieToken) ||
    !csrfTokenIsValid(submittedToken) ||
    !timingSafeEqualText(cookieToken, submittedToken)
  ) {
    return res.status(403).send('Solicitação inválida. Atualize a página e tente novamente.');
  }
  return next();
}

export function requireAuth(req, res, next) {
  try {
    const secret = process.env.SESSION_SECRET;
    const token = req.cookies?.[COOKIE_NAME];
    if (!secret || !token) return res.redirect('/login');
    req.user = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'crm-meta-panel',
      issuer: 'crm-meta-bridge',
    });
    return next();
  } catch {
    clearSession(res);
    return res.redirect('/login');
  }
}
