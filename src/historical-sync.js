import { canTransition } from './funnel.js';

const STAGE_ORDER = Object.freeze({
  NEW: 0,
  CONTACTED: 1,
  QUALIFIED: 2,
  VESTIBULAR_REGISTERED: 3,
  VESTIBULAR_COMPLETED: 4,
  MATRICULATED: 5,
});

export function canonicalInboundStage(stages) {
  const unique = [...new Set(stages)];
  if (unique.length === 2 && unique.includes('NEW') && unique.includes('CONTACTED')) {
    return 'CONTACTED';
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
  if (desiredStage === 'MATRICULATED') {
    return {
      action: 'PENDING_CONFIRMATION',
      code: 'MATRICULATION_REQUIRES_CONFIRMATION',
      targetStage: desiredStage,
    };
  }
  if (currentStage === desiredStage) {
    return { action: 'NOOP', code: 'STAGE_ALREADY_CORRECT', targetStage: desiredStage };
  }
  if (
    desiredStage !== 'LOST' &&
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
    WA2_CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
    CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
    WA2_CONTACT_AMBIGUOUS: 'AMBIGUOUS',
    CONTACT_AMBIGUOUS: 'AMBIGUOUS',
    WA2_LID_UNRESOLVED: 'LID',
    WA2_GROUP_UNSUPPORTED: 'GROUP',
    WA2_BROADCAST_UNSUPPORTED: 'GROUP',
    WA2_PHONE_INVALID: 'PHONE_INVALID',
  }[error?.remoteCode || error?.code] || 'FAILED';
}
