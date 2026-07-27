import crypto from 'node:crypto';

const MAX_AGE_MS = 10 * 60 * 1000;
const HMAC_DOMAIN = 'crm-meta-super-educar:wa2-link-resolution:hmac:v1';
export const WA2_LINK_RESOLUTION_PURPOSE = 'wa2-link-resolution:v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function signedPayload(context, timestamp) {
  const expectedAction = context.expectedAction;
  const expectedLinkId = context.expectedLinkId || null;
  if (!['CREATE', 'REPLACE'].includes(expectedAction)) {
    throw new Error('Ação esperada de confirmação WA2 inválida');
  }
  if (
    (expectedAction === 'CREATE' && expectedLinkId !== null) ||
    (expectedAction === 'REPLACE' && !UUID_PATTERN.test(expectedLinkId || ''))
  ) {
    throw new Error('Vínculo esperado de confirmação WA2 inválido');
  }
  return JSON.stringify({
    purpose: WA2_LINK_RESOLUTION_PURPOSE,
    leadId: context.leadId,
    instanceId: context.instanceId,
    phoneNormalized: context.phoneNormalized,
    remoteContactId: context.resolved.contact.id,
    remoteChatId: context.resolved.chat.id,
    jid: context.resolved.chat.jid,
    expectedAction,
    expectedLinkId,
    timestamp,
  });
}

function signature(context, timestamp, secret) {
  const payload = signedPayload(context, timestamp);
  return crypto.createHmac('sha256', secret)
    .update(`${HMAC_DOMAIN}\0${payload}`)
    .digest('hex');
}

export function createWa2ResolutionToken(context, {
  secret,
  now = Date.now(),
} = {}) {
  if (!secret) throw new Error('Segredo de confirmação WA2 não configurado');
  const timestamp = String(now);
  return `${timestamp}.${signature(context, timestamp, secret)}`;
}

export function wa2ResolutionTokenIsValid(token, context, {
  secret,
  now = Date.now(),
} = {}) {
  if (!secret) return false;
  const [timestamp, receivedSignature] = String(token || '').split('.');
  if (
    !/^\d{13}$/.test(timestamp || '') ||
    !/^[a-f0-9]{64}$/i.test(receivedSignature || '')
  ) {
    return false;
  }
  const age = now - Number(timestamp);
  if (age < -60_000 || age > MAX_AGE_MS) return false;
  let expectedSignature;
  try {
    expectedSignature = signature(context, timestamp, secret);
  } catch {
    return false;
  }
  const received = Buffer.from(receivedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
