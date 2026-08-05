export const STAGE_SOURCES = Object.freeze({
  WHATSAPP_LABEL: 'WHATSAPP_LABEL',
  MANUAL_TWO_STEP_PENDING: 'MANUAL_TWO_STEP_PENDING',
  MANUAL_TWO_STEP_APPROVED: 'MANUAL_TWO_STEP_APPROVED',
  SYSTEM_PROTECTED: 'SYSTEM_PROTECTED',
  LEGACY_UNVERIFIED: 'LEGACY_UNVERIFIED',
});

export const STAGE_VERIFICATION_STATUSES = Object.freeze({
  VERIFIED: 'VERIFIED',
  UNVERIFIED_LEGACY: 'UNVERIFIED_LEGACY',
  UNVERIFIED_NO_LABEL: 'UNVERIFIED_NO_LABEL',
  CONFLICT: 'CONFLICT',
  PENDING_WA_LABEL: 'PENDING_WA_LABEL',
  PROTECTED: 'PROTECTED',
});

export const MQL_VALIDITY = Object.freeze({
  VALID: 'VALID',
  INVALIDATED: 'INVALIDATED',
});

export const MANUAL_STAGE_REQUEST_STATUSES = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED_PENDING_WA: 'APPROVED_PENDING_WA',
  PENDING_WA_LINK: 'PENDING_WA_LINK',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
});

export const MQL_AUDIT_CLASSES = Object.freeze([
  'VALID_LABEL_CONFIRMED',
  'INVALID_NO_QUALIFYING_LABEL',
  'INVALID_LABEL_REMOVED_BEFORE_EVENT',
  'INVALID_STAGE_ONLY',
  'INVALID_RECONCILIATION_ASSUMPTION',
  'INVALID_INTERNAL_TEST',
  'AMBIGUOUS_MULTIPLE_LABELS',
  'AMBIGUOUS_NO_WA_EVIDENCE',
  'VALID_MANUAL_TWO_STEP',
]);

export function isQualifyingStage(stage) {
  return ['QUALIFIED', 'OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']
    .includes(stage);
}

export function canonicalStageForBindingStages(stages) {
  const values = new Set(Array.isArray(stages) ? stages.filter(Boolean) : []);
  if (values.has('PAID')) return 'PAID';
  if (values.has('ENROLLED')) return 'ENROLLED';
  if (['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].some((stage) => values.has(stage))) return 'LOST';
  if (['OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].some((stage) => values.has(stage))) return 'OPPORTUNITY';
  if (values.has('NEGOTIATING')) return 'NEGOTIATING';
  if (values.has('QUALIFIED')) return 'QUALIFIED';
  if (['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'].some((stage) => values.has(stage))) return 'IN_SERVICE';
  return null;
}

export function classifyMqlEvidence({
  internalTest = false,
  qualifyingLabelCount = 0,
  activeQualifyingLabelCount = 0,
  qualifyingLabelRemovedBeforeEvent = false,
  anyWaEvidence = false,
  stageOnly = false,
  reconciliationEvidence = false,
  multipleLabels = false,
  manualTwoStep = false,
} = {}) {
  if (internalTest) return 'INVALID_INTERNAL_TEST';
  if (multipleLabels) return 'AMBIGUOUS_MULTIPLE_LABELS';
  if (manualTwoStep && activeQualifyingLabelCount > 0) return 'VALID_MANUAL_TWO_STEP';
  if (activeQualifyingLabelCount === 1) return 'VALID_LABEL_CONFIRMED';
  if (qualifyingLabelRemovedBeforeEvent || (qualifyingLabelCount > 0 && activeQualifyingLabelCount === 0)) {
    return 'INVALID_LABEL_REMOVED_BEFORE_EVENT';
  }
  if (stageOnly) return 'INVALID_STAGE_ONLY';
  if (reconciliationEvidence) return 'INVALID_RECONCILIATION_ASSUMPTION';
  if (!anyWaEvidence) return 'AMBIGUOUS_NO_WA_EVIDENCE';
  return 'INVALID_NO_QUALIFYING_LABEL';
}

export function isMetaOutboundEligibleByStageTruth(lead) {
  return lead?.stage_source === STAGE_SOURCES.WHATSAPP_LABEL
    && lead?.stage_verification_status === STAGE_VERIFICATION_STATUSES.VERIFIED;
}
