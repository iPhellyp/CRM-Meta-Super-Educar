import {
  getBrazilianPhoneIdentity,
  normalizeConfirmedWhatsAppPhone,
} from './phone.js';
import { normalizeWa2LabelName } from './wa2-label-sync.js';

export const WA2_REPLACEMENT_RESULTS = Object.freeze([
  'EXACT_SINGLE_MATCH',
  'ALREADY_ALIGNED',
  'NO_MATCH',
  'MULTIPLE_MATCHES',
  'IDENTITY_CONFLICT',
  'PHONE_CONFLICT',
  'INVALID_PHONE',
  'LID_WITHOUT_PN',
  'NON_INDIVIDUAL_CHAT',
]);

export const WA2_REPLACEMENT_CODES = Object.freeze([
  'CRM01', 'CRM02', 'CRM03', 'CRM04', 'CRM05', 'CRM99',
]);

export const WA2_REPLACEMENT_LABEL_NAMES = Object.freeze({
  CRM01: 'CRM 01 - Em atendimento',
  CRM02: 'CRM 02 - Qualificado',
  CRM03: 'CRM 03 - Inscrição no vestibular',
  CRM04: 'CRM 04 - Vestibular concluído',
  CRM05: 'CRM 05 - Matriculado',
  CRM99: 'CRM 99 - Perdido',
});

const PN_PATTERN = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i;
const LID_PATTERN = /^[a-z0-9._:-]+@lid$/i;

function safeText(value, max = 200) {
  if (value == null) return null;
  const text = String(value).trim();
  return text && text.length <= max ? text : null;
}

function whatsappIdentity(value, { confirmedMobile = true } = {}) {
  const identity = getBrazilianPhoneIdentity(value, { confirmedMobile });
  if (!identity.canonicalE164) return null;
  const accepted = confirmedMobile
    ? ['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY']
    : ['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY', 'BR_FIXED'];
  if (!accepted.includes(identity.classification)) return null;
  return identity;
}

export function normalizeCanonicalWhatsAppPhone(value, { confirmedMobile = true } = {}) {
  const raw = safeText(value, 80);
  if (!raw) return null;
  const jidMatch = PN_PATTERN.exec(raw);
  const candidate = jidMatch ? jidMatch[1] : raw;
  return whatsappIdentity(candidate, { confirmedMobile })?.canonicalE164 || null;
}

export function normalizePnJid(value, { confirmedMobile = true } = {}) {
  const raw = safeText(value, 255)?.toLowerCase();
  const match = raw ? PN_PATTERN.exec(raw) : null;
  if (!match) return null;
  const canonicalPhone = normalizeCanonicalWhatsAppPhone(match[1], { confirmedMobile });
  if (!canonicalPhone) return null;
  return `${canonicalPhone}@s.whatsapp.net`;
}

export function compareStableWhatsAppIdentity({ canonicalPhone, normalizedPnJid, phoneJid } = {}) {
  const canonical = normalizeCanonicalWhatsAppPhone(canonicalPhone);
  const normalizedPn = normalizePnJid(normalizedPnJid);
  const observedPn = normalizePnJid(phoneJid);
  return {
    canonicalPhone: canonical,
    normalizedPnJid: normalizedPn,
    observedPnJid: observedPn,
    sameCanonicalPhone: Boolean(canonical && normalizedPn && canonical === normalizedPn.slice(0, -'@s.whatsapp.net'.length)),
    samePn: Boolean(normalizedPn && observedPn && normalizedPn === observedPn),
    sameBrazilianMobileIdentity: Boolean(
      canonical && normalizedPn && observedPn &&
      canonical === normalizedPn.slice(0, -'@s.whatsapp.net'.length) &&
      normalizedPn === observedPn,
    ),
  };
}

export function isWa2ReplacementEventAfterCutover(observedAt, cutoverAt) {
  if (!cutoverAt) return true;
  const observed = new Date(observedAt).getTime();
  const cutover = new Date(cutoverAt).getTime();
  return Number.isFinite(observed) && Number.isFinite(cutover) && observed > cutover;
}

function connected(value) {
  return /^(CONNECTED|OPEN|READY)$/i.test(String(value || '').trim());
}

function instanceInactive(instance, status) {
  return instance?.enabled === false ||
    /^(REMOTE_DELETED|DISCONNECTED|INACTIVE|DELETED)$/i.test(String(instance?.remote_status || '')) ||
    (status && !connected(status.status));
}

function authenticatedIdentity(status) {
  const phone = normalizeCanonicalWhatsAppPhone(status?.phone, { confirmedMobile: true });
  if (!phone) return null;
  return {
    canonicalPhone: phone,
    normalizedPnJid: `${phone}@s.whatsapp.net`,
    connected: connected(status?.status),
  };
}

export function detectWa2InstanceReplacement({
  tenantId,
  oldInstance,
  newInstance,
  oldStatus = null,
  newStatus = null,
  activeInstanceCount = 1,
} = {}) {
  if (!oldInstance || !newInstance || oldInstance.tenant_id !== tenantId || newInstance.tenant_id !== tenantId) {
    return { classification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'TENANT_MISMATCH' };
  }
  if (oldInstance.id === newInstance.id) {
    return { classification: 'ALREADY_ALIGNED', reasonCode: 'SAME_INSTANCE' };
  }
  const oldIdentity = authenticatedIdentity(oldStatus) || (
    normalizeCanonicalWhatsAppPhone(oldInstance.phone, { confirmedMobile: true })
      ? {
        canonicalPhone: normalizeCanonicalWhatsAppPhone(oldInstance.phone, { confirmedMobile: true }),
        normalizedPnJid: `${normalizeCanonicalWhatsAppPhone(oldInstance.phone, { confirmedMobile: true })}@s.whatsapp.net`,
        connected: connected(oldInstance.remote_status),
      }
      : null
  );
  const newIdentity = authenticatedIdentity(newStatus);
  if (!newIdentity) return { classification: 'MISSING_AUTHENTICATED_PN', reasonCode: 'MISSING_AUTHENTICATED_PN' };
  if (!newIdentity.connected) return { classification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NEW_INSTANCE_NOT_CONNECTED' };
  if (!oldIdentity) return { classification: 'MISSING_AUTHENTICATED_PN', reasonCode: 'OLD_AUTHENTICATED_PN_UNKNOWN' };
  if (activeInstanceCount > 1) return { classification: 'MULTIPLE_ACTIVE_INSTANCES', reasonCode: 'MULTIPLE_ACTIVE_INSTANCES' };
  if (oldIdentity.canonicalPhone !== newIdentity.canonicalPhone || oldIdentity.normalizedPnJid !== newIdentity.normalizedPnJid) {
    return {
      classification: 'NEW_WHATSAPP_ACCOUNT',
      reasonCode: 'PHONE_IDENTITY_CONFLICT',
      oldIdentity,
      newIdentity,
    };
  }
  if (!instanceInactive(oldInstance, oldStatus)) {
    return { classification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'OLD_INSTANCE_STILL_ACTIVE', oldIdentity, newIdentity };
  }
  return {
    classification: 'SAME_ACCOUNT_REPLACEMENT',
    reasonCode: 'AUTHENTICATED_PN_MATCHED',
    oldIdentity,
    newIdentity,
  };
}

export function logicalCrmCodeFromLabelName(name) {
  const normalized = normalizeWa2LabelName(name);
  return WA2_REPLACEMENT_CODES.find((code) => normalizeWa2LabelName(WA2_REPLACEMENT_LABEL_NAMES[code]) === normalized) || null;
}

export function planWa2LabelRemap(newLabels = [], requiredCodes = WA2_REPLACEMENT_CODES, existingBindings = []) {
  const result = {
    exactMatches: [],
    notFound: [],
    ambiguous: [],
    alreadyAligned: [],
  };
  for (const code of requiredCodes) {
    const expected = normalizeWa2LabelName(WA2_REPLACEMENT_LABEL_NAMES[code] || '');
    const matches = newLabels.filter((label) => normalizeWa2LabelName(label?.name) === expected);
    const aligned = matches.length === 1 && existingBindings.some((binding) =>
      binding.enabled !== false && binding.stage && binding.remote_label_id === matches[0].id &&
      normalizeWa2LabelName(binding.remote_label_name) === expected
    );
    if (matches.length === 1 && aligned) result.alreadyAligned.push({ code, label: matches[0] });
    else if (matches.length === 1) result.exactMatches.push({ code, label: matches[0] });
    else if (matches.length === 0) result.notFound.push(code);
    else result.ambiguous.push({ code, count: matches.length });
  }
  return result;
}

function classifyCandidate(candidate) {
  if (!candidate) return { result: 'NO_MATCH', reasonCode: 'CONTACT_NOT_FOUND' };
  if (candidate.isGroup || candidate.isNewsletter || candidate.isBroadcast) {
    return { result: 'NON_INDIVIDUAL_CHAT', reasonCode: 'NON_INDIVIDUAL_CHAT' };
  }
  const canonicalPhone = normalizeCanonicalWhatsAppPhone(candidate.phoneNormalized, { confirmedMobile: true });
  const phoneJid = normalizePnJid(candidate.phoneJid || candidate.contactJid || candidate.jid, { confirmedMobile: true });
  if (!canonicalPhone || !phoneJid) {
    if (LID_PATTERN.test(String(candidate.jid || candidate.chatJid || ''))) {
      return { result: 'LID_WITHOUT_PN', reasonCode: 'LID_WITHOUT_PN' };
    }
    return { result: 'INVALID_PHONE', reasonCode: 'INVALID_PHONE' };
  }
  if (phoneJid !== `${canonicalPhone}@s.whatsapp.net`) {
    return { result: 'PHONE_CONFLICT', reasonCode: 'PHONE_CONFLICT' };
  }
  if (candidate.identityPresent !== true || Number(candidate.identityCount) !== 1 || Number(candidate.newIdentityCount) > 1) {
    return { result: 'IDENTITY_CONFLICT', reasonCode: 'VERIFIED_IDENTITY_MISSING_OR_AMBIGUOUS' };
  }
  if (candidate.oldIdentityCanonicalPhone && candidate.oldIdentityCanonicalPhone !== canonicalPhone) {
    return { result: 'IDENTITY_CONFLICT', reasonCode: 'VERIFIED_IDENTITY_PHONE_CONFLICT' };
  }
  if (Number(candidate.activeLinkCount) > 1) {
    return { result: 'IDENTITY_CONFLICT', reasonCode: 'ACTIVE_LINK_AMBIGUOUS' };
  }
  if (candidate.identityOwnerLeadId && candidate.identityOwnerLeadId !== candidate.leadId) {
    return { result: 'IDENTITY_CONFLICT', reasonCode: 'IDENTITY_CONFLICT' };
  }
  if (candidate.activeLinkLeadId && candidate.activeLinkLeadId !== candidate.leadId) {
    return { result: 'IDENTITY_CONFLICT', reasonCode: 'IDENTITY_CONFLICT' };
  }
  if (candidate.alreadyAligned === true) return { result: 'ALREADY_ALIGNED', reasonCode: 'ALREADY_ALIGNED', canonicalPhone, phoneJid };
  return {
    result: 'EXACT_SINGLE_MATCH',
    reasonCode: 'EXACT_PN_MATCH',
    canonicalPhone,
    phoneJid,
    chatId: safeText(candidate.chatId, 200),
    contactId: safeText(candidate.contactId, 200),
  };
}

export function classifyWa2LinkCandidates({ leadId, oldLink, candidates = [] } = {}) {
  const oldPhone = normalizeCanonicalWhatsAppPhone(oldLink?.phone_normalized, { confirmedMobile: true });
  if (!oldPhone) return { leadId, result: 'INVALID_PHONE', reasonCode: 'INVALID_PHONE' };
  const matching = candidates.filter((candidate) => {
    const phone = normalizeCanonicalWhatsAppPhone(candidate?.phoneNormalized, { confirmedMobile: true });
    const pn = normalizePnJid(candidate?.phoneJid || candidate?.contactJid || candidate?.jid, { confirmedMobile: true });
    return phone === oldPhone || pn === `${oldPhone}@s.whatsapp.net`;
  });
  if (matching.length === 0) return { leadId, result: 'NO_MATCH', reasonCode: 'CONTACT_NOT_FOUND' };
  if (matching.length > 1) return { leadId, result: 'MULTIPLE_MATCHES', reasonCode: 'MULTIPLE_MATCHES' };
  return { leadId, ...classifyCandidate({ ...matching[0], leadId }) };
}

export function planWa2InstanceReplacement({
  tenantId,
  oldInstance,
  newInstance,
  oldStatus,
  newStatus,
  activeInstanceCount = 1,
  oldLinks = [],
  candidatesByLeadId = {},
  newLabels = [],
  existingBindings = [],
} = {}) {
  const detection = detectWa2InstanceReplacement({
    tenantId,
    oldInstance,
    newInstance,
    oldStatus,
    newStatus,
    activeInstanceCount,
  });
  const labels = planWa2LabelRemap(newLabels, WA2_REPLACEMENT_CODES, existingBindings);
  const items = oldLinks.map((link) => classifyWa2LinkCandidates({
    leadId: link.lead_id,
    oldLink: link,
    candidates: candidatesByLeadId[link.lead_id] || [],
  }));
  const counts = Object.fromEntries(WA2_REPLACEMENT_RESULTS.map((result) => [result, 0]));
  for (const item of items) counts[item.result] += 1;
  return {
    classification: detection.classification,
    detection,
    labels,
    items,
    counts,
    totalLinks: items.length,
    recoverableLinks: counts.EXACT_SINGLE_MATCH,
    alreadyAligned: counts.ALREADY_ALIGNED,
    blockedLinks: items.length - counts.EXACT_SINGLE_MATCH - counts.ALREADY_ALIGNED,
    labelMatches: labels.exactMatches.length + labels.alreadyAligned.length,
    labelConflicts: labels.ambiguous.length + labels.notFound.length,
    writes: {
      oldLinksToUnlink: detection.classification === 'SAME_ACCOUNT_REPLACEMENT' ? counts.EXACT_SINGLE_MATCH : 0,
      newLinksToCreate: detection.classification === 'SAME_ACCOUNT_REPLACEMENT' ? counts.EXACT_SINGLE_MATCH : 0,
      bindingsToCreate: detection.classification === 'SAME_ACCOUNT_REPLACEMENT' ? labels.exactMatches.length : 0,
      stagesChanged: 0,
      mqlsCreated: 0,
      conversionJobs: 0,
      graphPosts: 0,
      writesPerformed: 0,
    },
  };
}

export function maskReplacementPhone(value) {
  const phone = normalizeCanonicalWhatsAppPhone(value, { confirmedMobile: true });
  return phone ? `••••${phone.slice(-4)}` : 'AUSENTE';
}
