export const STAGES = Object.freeze({
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  QUALIFIED: 'QUALIFIED',
  VESTIBULAR_REGISTERED: 'VESTIBULAR_REGISTERED',
  VESTIBULAR_COMPLETED: 'VESTIBULAR_COMPLETED',
  MATRICULATED: 'MATRICULATED',
  LOST: 'LOST',
  OPPORTUNITY: 'OPPORTUNITY',
});

export const STAGE_LABELS = Object.freeze({
  [STAGES.NEW]: 'Novo',
  [STAGES.CONTACTED]: 'CRM 01 - Em atendimento',
  [STAGES.QUALIFIED]: 'CRM 02 - Qualificado',
  [STAGES.VESTIBULAR_REGISTERED]: 'CRM 03 - Inscrição no vestibular',
  [STAGES.VESTIBULAR_COMPLETED]: 'CRM 04 - Vestibular concluído',
  [STAGES.OPPORTUNITY]: 'CRM 04 - Vestibular concluído',
  [STAGES.MATRICULATED]: 'CRM 05 - Matriculado',
  [STAGES.LOST]: 'CRM 99 - Perdido',
});

const TRANSITIONS = Object.freeze({
  [STAGES.NEW]: Object.freeze([STAGES.CONTACTED]),
  [STAGES.CONTACTED]: Object.freeze([STAGES.QUALIFIED, STAGES.LOST]),
  [STAGES.QUALIFIED]: Object.freeze([STAGES.VESTIBULAR_REGISTERED, STAGES.LOST]),
  [STAGES.VESTIBULAR_REGISTERED]: Object.freeze([STAGES.VESTIBULAR_COMPLETED, STAGES.LOST]),
  [STAGES.VESTIBULAR_COMPLETED]: Object.freeze([STAGES.MATRICULATED, STAGES.LOST]),
  [STAGES.OPPORTUNITY]: Object.freeze([STAGES.MATRICULATED, STAGES.LOST]),
  [STAGES.LOST]: Object.freeze([STAGES.CONTACTED]),
  [STAGES.MATRICULATED]: Object.freeze([]),
});

const ACTION_LABELS = Object.freeze({
  [STAGES.CONTACTED]: 'Em atendimento',
  [STAGES.QUALIFIED]: 'Qualificar',
  [STAGES.VESTIBULAR_REGISTERED]: 'Inscrição no vestibular',
  [STAGES.VESTIBULAR_COMPLETED]: 'Vestibular concluído',
  [STAGES.MATRICULATED]: 'Matricular',
  [STAGES.LOST]: 'Perder',
});

const STAGE_EVENTS = Object.freeze({
  [STAGES.QUALIFIED]: 'Marketing Qualified Lead',
  [STAGES.VESTIBULAR_COMPLETED]: 'Sales Opportunity',
  [STAGES.MATRICULATED]: 'Converted',
});

export const HISTORY_ORIGINS = Object.freeze([
  'MANUAL',
  'META_WEBHOOK',
  'SYSTEM',
  'SR_GESTAO',
  'WHATSAPP',
]);

const historyOrigins = new Set(HISTORY_ORIGINS);
const directStageTargets = new Set([
  STAGES.CONTACTED,
  STAGES.QUALIFIED,
  STAGES.VESTIBULAR_REGISTERED,
  STAGES.VESTIBULAR_COMPLETED,
  STAGES.LOST,
]);

export function isKnownStage(stage) {
  return Object.hasOwn(TRANSITIONS, stage);
}

export function isDirectStageTarget(stage) {
  return directStageTargets.has(stage);
}

export function canTransition(previousStage, newStage) {
  return isKnownStage(previousStage) && TRANSITIONS[previousStage].includes(newStage);
}

export function getStageActions(stage) {
  if (!isKnownStage(stage)) return [];
  return TRANSITIONS[stage].map((target) => ({
    stage: target,
    label: stage === STAGES.LOST && target === STAGES.CONTACTED
      ? 'Reativar atendimento'
      : ACTION_LABELS[target],
  }));
}

export function getStageEventName(stage) {
  return STAGE_EVENTS[stage] || null;
}

export function getStageBadgeClass(stage) {
  if (stage === STAGES.VESTIBULAR_REGISTERED) return 'qualified';
  if ([STAGES.VESTIBULAR_COMPLETED, STAGES.OPPORTUNITY].includes(stage)) return 'opportunity';
  return String(stage || STAGES.NEW).toLowerCase();
}

export function isValidHistoryOrigin(origin) {
  return historyOrigins.has(origin);
}
