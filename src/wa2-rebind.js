import crypto from 'node:crypto';

export const WA2_CHAT_REBIND_REASON = 'WHATSAPP_CHAT_REBOUND_AFTER_NEW_SESSION_2026_08_04';
export const WA2_CHAT_REBIND_ACTIVITY = 'WA2_CHAT_REBOUND';
export const WA2_NORMAL_CHAT_REBIND_REASON = 'CURRENT_OFFICIAL_LABEL_CHAT_REPLACED_LEGACY_LINK';
export const WA2_CURRENT_LABEL_CONFIRMATION_ACTIVITY = 'WA2_CURRENT_LABEL_STATE_CONFIRMED';
export const WA2_CURRENT_LABEL_EVIDENCE_TYPES = new Set([
  'WA2_CURRENT_LABEL_STATE',
  'WA2_CONTACT_STATE',
  'WA2_LABEL_APPLY_EVENT',
]);

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

export function normalRebindPayloadHash({
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
  remoteLabelId,
  remoteLabelName,
  evidenceType,
  evidenceReference,
  sourceEventId,
  remoteInstanceId,
  observedAt,
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
    remoteLabelId,
    remoteLabelName,
    evidenceType,
    evidenceReference,
    sourceEventId,
    remoteInstanceId,
    new Date(observedAt).toISOString(),
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

export function validateCurrentLabelEvidence({
  tenantId,
  leadId,
  instanceId,
  chatId,
  contactId,
  remoteLabelId,
  remoteLabelName,
  operation,
  observedAt,
  evidenceType,
  evidenceReference,
  sourceEventId,
}) {
  const fields = [
    ['tenantId', tenantId, 120],
    ['leadId', leadId, 120],
    ['instanceId', instanceId, 120],
    ['chatId', chatId, 200],
    ['contactId', contactId, 200],
    ['remoteLabelId', remoteLabelId, 128],
    ['remoteLabelName', remoteLabelName, 200],
    ['evidenceReference', evidenceReference, 255],
  ];
  for (const [field, value, max] of fields) text(value, field, { max });
  if (!WA2_CURRENT_LABEL_EVIDENCE_TYPES.has(String(evidenceType || ''))) {
    throw new Error('Tipo de evidência de etiqueta inválido');
  }
  if (operation !== 'APPLY') throw new Error('A evidência da etiqueta não é APPLY');
  const parsedObservedAt = new Date(observedAt);
  if (!Number.isFinite(parsedObservedAt.getTime())) throw new Error('Timestamp da etiqueta inválido');
  if (sourceEventId != null) text(sourceEventId, 'sourceEventId', { max: 120 });
  if (evidenceType === 'WA2_LABEL_APPLY_EVENT' && !sourceEventId) {
    throw new Error('Evento APPLY obrigatório para esta evidência');
  }
  return {
    tenantId: String(tenantId).trim(),
    leadId: String(leadId).trim(),
    instanceId: String(instanceId).trim(),
    chatId: String(chatId).trim(),
    contactId: String(contactId).trim(),
    remoteLabelId: String(remoteLabelId).trim(),
    remoteLabelName: String(remoteLabelName).trim(),
    operation,
    observedAt: parsedObservedAt.toISOString(),
    evidenceType: String(evidenceType).trim(),
    evidenceReference: String(evidenceReference).trim(),
    sourceEventId: sourceEventId ? String(sourceEventId).trim() : null,
  };
}

export function createNormalRebindHistoryMetadata({
  identityId = null,
  oldLinkId,
  newLinkId,
  instanceId,
  oldRemoteChatId,
  newRemoteChatId,
  remoteContactId,
  pn,
  lid,
  evidenceReference,
  evidenceType,
  observedAt,
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
    evidenceReferenceHash: sha256(evidenceReference),
    evidenceType,
    observedAt: new Date(observedAt).toISOString(),
    reason,
    actor: actor || 'system',
    idempotencyKey,
    payloadHash,
  };
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
