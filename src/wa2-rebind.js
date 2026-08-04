import crypto from 'node:crypto';

export const WA2_CHAT_REBIND_REASON = 'WHATSAPP_CHAT_REBOUND_AFTER_NEW_SESSION_2026_08_04';
export const WA2_CHAT_REBIND_ACTIVITY = 'WA2_CHAT_REBOUND';

function text(value, field, { max = 255, required = true } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${field} obrigatório`);
  if (result.length > max) throw new Error(`${field} inválido`);
  return result;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value)))].sort();
}

export function sameAliasSet(left, right) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

export function rebindPayloadHash({
  leadId,
  instanceId,
  expectedActiveLinkId,
  expectedOldRemoteChatId,
  newRemoteChatId,
  newRemoteContactId,
  newRemoteJid,
  canonicalPhone,
  pn,
  lid,
  evidenceWaMessageId,
  evidenceTimestamp,
  reason,
  idempotencyKey,
}) {
  return sha256(JSON.stringify([
    leadId,
    instanceId,
    expectedActiveLinkId,
    expectedOldRemoteChatId,
    newRemoteChatId,
    newRemoteContactId,
    newRemoteJid,
    canonicalPhone,
    pn,
    lid,
    evidenceWaMessageId,
    new Date(evidenceTimestamp).toISOString(),
    reason,
    idempotencyKey,
  ]));
}

export function validateRebindAdapterEvidence(evidence, expected) {
  if (evidence?.adapterValidated !== true || evidence?.fromMe !== false) {
    throw new Error('Evidência WA2 inválida');
  }
  const checks = [
    ['instanceId', evidence.instanceId, expected.instanceId],
    ['chatId', evidence.chatId, expected.chatId],
    ['contactId', evidence.contactId, expected.contactId],
    ['waMessageId', evidence.waMessageId, expected.waMessageId],
    ['lidJid', evidence.lidJid, expected.lidJid],
    ['phoneJid', evidence.phoneJid, expected.phoneJid],
  ];
  for (const [field, actual, required] of checks) {
    if (text(actual, field) !== text(required, field)) throw new Error(`Evidência ${field} divergente`);
  }
  const observedAt = new Date(evidence.observedAt);
  const expectedAt = new Date(expected.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() !== expectedAt.getTime()) {
    throw new Error('Evidência observedAt divergente');
  }
  return true;
}

export function createRebindHistoryMetadata({
  identityId,
  oldLinkId,
  newLinkId,
  instanceId,
  oldRemoteChatId,
  newRemoteChatId,
  remoteContactId,
  pn,
  lid,
  evidenceWaMessageId,
  evidenceTimestamp,
  reason,
  actor,
  idempotencyKey,
  payloadHash,
}) {
  return {
    event: WA2_CHAT_REBIND_ACTIVITY,
    identityId,
    oldLinkId,
    newLinkId,
    instanceId,
    previousRemoteChatHash: sha256(oldRemoteChatId),
    newRemoteChatHash: sha256(newRemoteChatId),
    remoteContactHash: sha256(remoteContactId),
    pnHash: sha256(pn),
    lidHash: sha256(lid),
    evidenceWaMessageIdHash: sha256(evidenceWaMessageId),
    evidenceTimestamp: new Date(evidenceTimestamp).toISOString(),
    reason,
    actor: actor || 'system',
    idempotencyKey,
    payloadHash,
  };
}
