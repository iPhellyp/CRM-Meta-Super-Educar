import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function encryptionKey(env = process.env) {
  const encoded = String(env.META_CREDENTIALS_ENCRYPTION_KEY || '').trim();
  let key;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw new Error('META_CREDENTIALS_ENCRYPTION_KEY deve conter 32 bytes em Base64');
  }
  return key;
}

export function encryptSecret(value, env = process.env) {
  const plaintext = String(value || '');
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value, env = process.env) {
  const [version, ivText, tagText, encryptedText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
    throw new Error('Credencial criptografada inválida');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(env),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function maskSecret(value) {
  return value ? '••••••••' : '—';
}
