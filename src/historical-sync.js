import { canTransition } from './funnel.js';

const STAGE_ORDER = Object.freeze({
  NEW: 0,
  CONTACT_STARTED: 1,
  NO_RESPONSE: 1,
  IN_SERVICE: 2,
  QUALIFIED: 3,
  OPPORTUNITY: 4,
  NEGOTIATING: 5,
  AWAITING_ENROLLMENT: 6,
  AWAITING_PAYMENT: 7,
  ENROLLED: 8,
  PAID: 9,
});

export function canonicalInboundStage(stages) {
  const unique = [...new Set(stages)];
  const groups = [
    [['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'], 'IN_SERVICE'],
    [['QUALIFIED'], 'QUALIFIED'],
    [['NEGOTIATING'], 'NEGOTIATING'],
    [['OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'], 'OPPORTUNITY'],
    [['ENROLLED', 'PAID'], 'ENROLLED'],
    [['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'], 'LOST'],
  ];
  for (const [members, canonical] of groups) {
    if (unique.length > 0 && unique.every((stage) => members.includes(stage))) return canonical;
  }
  return unique.length === 1 ? unique[0] : null;
}

export function decideInboundLabelAction({
  event,
  currentStage,
  eventBindingStages = [],
  currentCrmLabelStages = [],
}) {
  if (event.source === 'INTERNAL_API') {
    return { action: 'IGNORED', code: 'INTERNAL_API_LOOP_GUARD' };
  }
  if (event.source === 'UNKNOWN') {
    return { action: 'CONFLICT', code: 'UNKNOWN_SOURCE' };
  }
  if (event.operation === 'REMOVE') {
    return { action: 'IGNORED', code: 'REMOVE_NO_REGRESSION' };
  }
  if (!event.eligibleForCrm) {
    return { action: 'IGNORED', code: event.ineligibleReason || 'NOT_ELIGIBLE' };
  }

  const desiredStage = canonicalInboundStage(eventBindingStages);
  if (!desiredStage) {
    return {
      action: 'CONFLICT',
      code: eventBindingStages.length ? 'AMBIGUOUS_EVENT_BINDING' : 'LABEL_NOT_BOUND',
    };
  }

  const activeStages = [...new Set(
    currentCrmLabelStages
      .map((stages) => canonicalInboundStage(Array.isArray(stages) ? stages : [stages]))
      .filter(Boolean),
  )];
  if (activeStages.length > 1) {
    return { action: 'CONFLICT', code: 'MULTIPLE_CRM_STAGE_LABELS' };
  }
  if (activeStages.length === 1 && activeStages[0] !== desiredStage) {
    return { action: 'CONFLICT', code: 'CRM_LABEL_STATE_DIVERGENT' };
  }
  if (['ENROLLED', 'PAID'].includes(desiredStage)) {
    return {
      action: 'CONFLICT',
      code: 'PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION',
      targetStage: desiredStage,
    };
  }
  if (currentStage === desiredStage) {
    return { action: 'NOOP', code: 'STAGE_ALREADY_CORRECT', targetStage: desiredStage };
  }
  if (
    !['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(desiredStage) &&
    STAGE_ORDER[currentStage] != null &&
    STAGE_ORDER[desiredStage] <= STAGE_ORDER[currentStage]
  ) {
    return { action: 'NOOP', code: 'NO_STAGE_REGRESSION', targetStage: desiredStage };
  }
  if (!canTransition(currentStage, desiredStage)) {
    return {
      action: 'CONFLICT',
      code: 'OFFICIAL_TRANSITION_NOT_ALLOWED',
      targetStage: desiredStage,
    };
  }
  return { action: 'STAGE_CHANGED', code: 'OFFICIAL_TRANSITION', targetStage: desiredStage };
}

export function historicalRetryDelayMs(attempts) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  return delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
}

export function sanitizeHistoricalError(error, fallbackCode) {
  const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(error?.code || ''))
    ? String(error.code)
    : fallbackCode;
  const message = String(error?.message || 'Falha de processamento')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  return { code, message };
}

export function reconciliationFailureResult(error) {
  return {
    WA2_CONTACT_NOT_FOUND: 'NOT_FOUND_IN_WA2',
    CONTACT_NOT_FOUND: 'NOT_FOUND_IN_WA2',
    WA2_CONTACT_AMBIGUOUS: 'CONFLICT',
    CONTACT_AMBIGUOUS: 'CONFLICT',
    WA2_LID_UNRESOLVED: 'LID_UNRESOLVED',
    WA2_GROUP_UNSUPPORTED: 'ERROR',
    WA2_BROADCAST_UNSUPPORTED: 'ERROR',
    WA2_PHONE_INVALID: 'PHONE_INVALID',
  }[error?.remoteCode || error?.code] || 'ERROR';
}
