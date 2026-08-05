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

const META_EVENT_STAGES = new Set([
  'QUALIFIED',
  'NEGOTIATING',
  'OPPORTUNITY',
  'AWAITING_ENROLLMENT',
  'AWAITING_PAYMENT',
]);

export function canCreateMetaForStage(stage, officialLabelEvidence = false) {
  return META_EVENT_STAGES.has(stage) && officialLabelEvidence === true;
}

export function isInternalTestLead(lead) {
  return lead?.is_internal_test === true || lead?.meta_outbound_eligible === false;
}

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

export function canAdvanceByOfficialCrmLabel(currentStage, desiredStage) {
  const allowed = {
    IN_SERVICE: ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE'],
    QUALIFIED: ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'],
    NEGOTIATING: ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE', 'QUALIFIED'],
    OPPORTUNITY: ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE', 'QUALIFIED', 'NEGOTIATING'],
  };
  return Boolean(allowed[desiredStage]?.includes(currentStage));
}

export function officialCrmLabelStageFor(stage) {
  if (['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'].includes(stage)) {
    return 'IN_SERVICE';
  }
  if (['OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].includes(stage)) {
    return 'OPPORTUNITY';
  }
  if (['ENROLLED', 'PAID'].includes(stage)) return 'ENROLLED';
  if (['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(stage)) {
    return 'LOST';
  }
  return stage || null;
}

function eventIsLaterThanPreviousLabel(eventObservedAt, previousLabelObservedAt) {
  const eventTime = Date.parse(String(eventObservedAt || ''));
  const previousTime = Date.parse(String(previousLabelObservedAt || ''));
  return Number.isFinite(eventTime) && Number.isFinite(previousTime) && eventTime > previousTime;
}

export function evaluateExclusiveStageTransition({
  currentStage,
  targetStage,
  currentCrmLabelStages = [],
  previousLabelObservedAt = null,
  eventObservedAt = null,
  identityMatch = true,
  linkMatch = true,
}) {
  const activeStages = currentCrmLabelStages
    .map((stages) => canonicalInboundStage(Array.isArray(stages) ? stages : [stages]))
    .filter(Boolean);
  const previousLabelStage = officialCrmLabelStageFor(currentStage);
  const previousCount = activeStages.filter((stage) => stage === previousLabelStage).length;
  const targetCount = activeStages.filter((stage) => stage === targetStage).length;
  const thirdStageLabels = activeStages.filter(
    (stage) => stage !== previousLabelStage && stage !== targetStage,
  ).length;
  const previousLabelMatchesCurrentStage =
    previousLabelStage !== targetStage && previousCount === 1;
  const eventLater = eventIsLaterThanPreviousLabel(eventObservedAt, previousLabelObservedAt);
  const validTransition = Boolean(
    targetStage &&
    previousLabelMatchesCurrentStage &&
    targetCount === 1 &&
    activeStages.length === 2 &&
    thirdStageLabels === 0 &&
    canAdvanceByOfficialCrmLabel(currentStage, targetStage) &&
    identityMatch === true &&
    linkMatch === true &&
    eventLater,
  );
  return {
    currentStage,
    targetStage,
    previousLabelMatchesCurrentStage,
    thirdStageLabels,
    identityMatch: identityMatch === true,
    linkMatch: linkMatch === true,
    eventLater,
    validTransition,
  };
}

function isExclusiveCleanupState({ currentStage, desiredStage, activeStages }) {
  if (currentStage !== desiredStage || activeStages.length !== 2 || !activeStages.includes(desiredStage)) {
    return false;
  }
  const previousStages = activeStages.filter((stage) => stage !== desiredStage);
  return previousStages.length === 1 && canAdvanceByOfficialCrmLabel(previousStages[0], desiredStage);
}

export function classifyWa2LinkResolution({
  instanceConfigured,
  linkCount = 0,
  phoneNormalized = null,
  jid = '',
  leadCount = 0,
  otherChatLinkCount = 0,
}) {
  if (!instanceConfigured) return 'INSTANCE_MISMATCH';
  if (linkCount > 1) return 'CHAT_LINK_MULTIPLE';
  if (linkCount === 1) return null;
  if (!phoneNormalized && /@lid$/i.test(String(jid || ''))) return 'LID_UNRESOLVED';
  if (!phoneNormalized) return 'LEAD_PHONE_NOT_FOUND';
  if (leadCount === 0) return 'LEAD_PHONE_NOT_FOUND';
  if (leadCount > 1) return 'LEAD_PHONE_MULTIPLE';
  if (otherChatLinkCount > 0) return 'REMOTE_CHAT_MULTIPLE';
  return 'CHAT_LINK_NOT_FOUND';
}

export function decideInboundLabelAction({
  event,
  currentStage,
  eventBindingStages = [],
  currentCrmLabelStages = [],
  previousLabelObservedAt = null,
  eventObservedAt = null,
  identityMatch = true,
  linkMatch = true,
}) {
  if (event.source === 'INTERNAL_API') {
    return { action: 'IGNORED', code: 'INTERNAL_API_LOOP_GUARD' };
  }
  if (event.source === 'UNKNOWN') {
    return { action: 'IGNORED', code: 'IGNORED_TECHNICAL_EVENT' };
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

  if (isExclusiveCleanupState({ currentStage, desiredStage, activeStages })) {
    return {
      action: 'NOOP',
      code: 'STAGE_ALREADY_CORRECT_LABEL_SYNC_PENDING_REMOVE',
      targetStage: desiredStage,
    };
  }

  if (activeStages.length > 1) {
    const exclusive = evaluateExclusiveStageTransition({
      currentStage,
      targetStage: desiredStage,
      currentCrmLabelStages,
      previousLabelObservedAt,
      eventObservedAt,
      identityMatch,
      linkMatch,
    });
    if (exclusive.validTransition) {
      return {
        action: 'STAGE_CHANGED',
        code: 'OFFICIAL_TRANSITION',
        targetStage: desiredStage,
        exclusiveTransition: true,
        transitionEvidence: exclusive,
      };
    }
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
  const directOfficialAdvance = canAdvanceByOfficialCrmLabel(currentStage, desiredStage);
  if (
    !['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(desiredStage) &&
    STAGE_ORDER[currentStage] != null &&
    STAGE_ORDER[desiredStage] <= STAGE_ORDER[currentStage] &&
    !directOfficialAdvance
  ) {
    return { action: 'NOOP', code: 'NO_STAGE_REGRESSION', targetStage: desiredStage };
  }
  if (!directOfficialAdvance && !canTransition(currentStage, desiredStage)) {
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
  const remoteCode = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(error?.remoteCode || ''))
    ? String(error.remoteCode)
    : null;
  const statusCode = {
    401: 'WA2_AUTHENTICATION_FAILED',
    403: 'WA2_AUTHORIZATION_FAILED',
    429: 'WA2_RATE_LIMITED',
  }[error?.status] || (
    Number.isInteger(error?.status) && error.status >= 500
      ? 'WA2_TEMPORARY_FAILURE'
      : error?.status === 404
        ? 'WA2_API_ROUTE_NOT_FOUND'
        : null
  );
  const localCode = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(error?.code || ''))
    ? String(error.code)
    : null;
  const code = remoteCode || statusCode || localCode || fallbackCode;
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
    LID_UNRESOLVED: 'LID_UNRESOLVED',
    WA2_GROUP_UNSUPPORTED: 'ERROR',
    WA2_BROADCAST_UNSUPPORTED: 'ERROR',
    WA2_PHONE_INVALID: 'PHONE_INVALID',
  }[error?.remoteCode || error?.code] || 'ERROR';
}
