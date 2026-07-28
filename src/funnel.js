export const STAGES = Object.freeze({
  NEW: 'NEW',
  CONTACT_STARTED: 'CONTACT_STARTED',
  NO_RESPONSE: 'NO_RESPONSE',
  IN_SERVICE: 'IN_SERVICE',
  QUALIFIED: 'QUALIFIED',
  OPPORTUNITY: 'OPPORTUNITY',
  NEGOTIATING: 'NEGOTIATING',
  AWAITING_ENROLLMENT: 'AWAITING_ENROLLMENT',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  ENROLLED: 'ENROLLED',
  PAID: 'PAID',
  LOST: 'LOST',
  NO_INTEREST: 'NO_INTEREST',
  INVALID_PHONE: 'INVALID_PHONE',
  DUPLICATED: 'DUPLICATED',
});

export const STAGE_LABELS = Object.freeze({
  [STAGES.NEW]: 'Novo',
  [STAGES.CONTACT_STARTED]: 'Atendimento iniciado',
  [STAGES.NO_RESPONSE]: 'Sem resposta',
  [STAGES.IN_SERVICE]: 'Em atendimento',
  [STAGES.QUALIFIED]: 'Qualificado',
  [STAGES.OPPORTUNITY]: 'Oportunidade',
  [STAGES.NEGOTIATING]: 'Em negociação',
  [STAGES.AWAITING_ENROLLMENT]: 'Aguardando matrícula',
  [STAGES.AWAITING_PAYMENT]: 'Aguardando pagamento',
  [STAGES.ENROLLED]: 'Matriculado',
  [STAGES.PAID]: 'Pago',
  [STAGES.LOST]: 'Perdido',
  [STAGES.NO_INTEREST]: 'Sem interesse',
  [STAGES.INVALID_PHONE]: 'Telefone inválido',
  [STAGES.DUPLICATED]: 'Duplicado',
});

export const LOST_REASON_LABELS = Object.freeze({
  NO_INTEREST: 'Sem interesse',
  NO_RESPONSE: 'Sem resposta',
  INVALID_PHONE: 'Número inválido',
  OUT_OF_PROFILE: 'Fora do perfil',
  COURSE_UNAVAILABLE: 'Curso indisponível',
  PRICE: 'Preço',
  DUPLICATED: 'Duplicado',
  ENROLLED_ELSEWHERE: 'Já matriculado em outro local',
  OTHER: 'Outro',
});

const LOSS_STAGES = Object.freeze([
  STAGES.LOST,
  STAGES.NO_INTEREST,
  STAGES.INVALID_PHONE,
  STAGES.DUPLICATED,
]);

const TRANSITIONS = Object.freeze({
  [STAGES.NEW]: Object.freeze([STAGES.CONTACT_STARTED, ...LOSS_STAGES]),
  [STAGES.CONTACT_STARTED]: Object.freeze([
    STAGES.NO_RESPONSE, STAGES.IN_SERVICE, STAGES.QUALIFIED, ...LOSS_STAGES,
  ]),
  [STAGES.NO_RESPONSE]: Object.freeze([
    STAGES.CONTACT_STARTED, STAGES.IN_SERVICE, ...LOSS_STAGES,
  ]),
  [STAGES.IN_SERVICE]: Object.freeze([
    STAGES.NO_RESPONSE, STAGES.QUALIFIED, ...LOSS_STAGES,
  ]),
  [STAGES.QUALIFIED]: Object.freeze([
    STAGES.OPPORTUNITY, STAGES.NEGOTIATING, STAGES.AWAITING_ENROLLMENT,
    STAGES.AWAITING_PAYMENT, ...LOSS_STAGES,
  ]),
  [STAGES.OPPORTUNITY]: Object.freeze([
    STAGES.NEGOTIATING, STAGES.AWAITING_ENROLLMENT, STAGES.AWAITING_PAYMENT,
    ...LOSS_STAGES,
  ]),
  [STAGES.NEGOTIATING]: Object.freeze([
    STAGES.AWAITING_ENROLLMENT, STAGES.AWAITING_PAYMENT, ...LOSS_STAGES,
  ]),
  [STAGES.AWAITING_ENROLLMENT]: Object.freeze([
    STAGES.AWAITING_PAYMENT, STAGES.ENROLLED, ...LOSS_STAGES,
  ]),
  [STAGES.AWAITING_PAYMENT]: Object.freeze([STAGES.ENROLLED, STAGES.PAID, ...LOSS_STAGES]),
  [STAGES.ENROLLED]: Object.freeze([STAGES.PAID]),
  [STAGES.PAID]: Object.freeze([]),
  [STAGES.LOST]: Object.freeze([STAGES.CONTACT_STARTED]),
  [STAGES.NO_INTEREST]: Object.freeze([STAGES.CONTACT_STARTED]),
  [STAGES.INVALID_PHONE]: Object.freeze([STAGES.CONTACT_STARTED]),
  [STAGES.DUPLICATED]: Object.freeze([STAGES.CONTACT_STARTED]),
});

const ACTION_LABELS = Object.freeze({
  [STAGES.CONTACT_STARTED]: 'Atendimento',
  [STAGES.NO_RESPONSE]: 'Sem resposta',
  [STAGES.IN_SERVICE]: 'Em atendimento',
  [STAGES.QUALIFIED]: 'Qualificar',
  [STAGES.OPPORTUNITY]: 'Oportunidade',
  [STAGES.NEGOTIATING]: 'Negociar',
  [STAGES.AWAITING_ENROLLMENT]: 'Aguardando matrícula',
  [STAGES.AWAITING_PAYMENT]: 'Aguardando pagamento',
  [STAGES.LOST]: 'Perder',
  [STAGES.NO_INTEREST]: 'Sem interesse',
  [STAGES.INVALID_PHONE]: 'Telefone inválido',
  [STAGES.DUPLICATED]: 'Duplicado',
});

const STAGE_EVENTS = Object.freeze({
  [STAGES.QUALIFIED]: 'Marketing Qualified Lead',
  [STAGES.OPPORTUNITY]: 'Sales Opportunity',
  [STAGES.NEGOTIATING]: 'Sales Opportunity',
  [STAGES.AWAITING_ENROLLMENT]: 'Sales Opportunity',
  [STAGES.AWAITING_PAYMENT]: 'Sales Opportunity',
  [STAGES.PAID]: 'Converted',
});

export const HISTORY_ORIGINS = Object.freeze([
  'MANUAL',
  'META_WEBHOOK',
  'SYSTEM',
  'SR_GESTAO',
  'WHATSAPP',
  'WA2',
]);

const historyOrigins = new Set(HISTORY_ORIGINS);
const trustedOnlyTargets = new Set([STAGES.ENROLLED, STAGES.PAID]);
const lossStageSet = new Set(LOSS_STAGES);

export function isKnownStage(stage) {
  return Object.hasOwn(TRANSITIONS, stage);
}

export function isDirectStageTarget(stage) {
  return isKnownStage(stage) && !trustedOnlyTargets.has(stage);
}

export function canTransition(previousStage, newStage) {
  return isKnownStage(previousStage) && TRANSITIONS[previousStage].includes(newStage);
}

export function getStageActions(stage) {
  if (!isKnownStage(stage)) return [];
  return TRANSITIONS[stage]
    .filter((target) => !trustedOnlyTargets.has(target))
    .map((target) => ({
      stage: target,
      label: lossStageSet.has(stage) && target === STAGES.CONTACT_STARTED
        ? 'Reativar atendimento'
        : ACTION_LABELS[target],
    }));
}

export function getStageEventName(stage) {
  return STAGE_EVENTS[stage] || null;
}

export function getStageBadgeClass(stage) {
  const classes = {
    [STAGES.CONTACT_STARTED]: 'contact-started',
    [STAGES.IN_SERVICE]: 'in-service',
    [STAGES.QUALIFIED]: 'qualified',
    [STAGES.OPPORTUNITY]: 'opportunity',
    [STAGES.NEGOTIATING]: 'negotiating',
    [STAGES.AWAITING_ENROLLMENT]: 'awaiting-enrollment',
    [STAGES.AWAITING_PAYMENT]: 'awaiting-payment',
    [STAGES.ENROLLED]: 'enrolled',
    [STAGES.PAID]: 'paid',
    [STAGES.LOST]: 'lost',
    [STAGES.NO_INTEREST]: 'lost',
    [STAGES.INVALID_PHONE]: 'lost',
    [STAGES.DUPLICATED]: 'lost',
  };
  return classes[stage] || String(stage || STAGES.NEW).toLowerCase();
}

export function isLossStage(stage) {
  return lossStageSet.has(stage);
}

export function isProtectedCommercialStage(stage) {
  return stage === STAGES.ENROLLED || stage === STAGES.PAID;
}

export function originMayConfirmProtectedStage(origin) {
  return ['SR_GESTAO', 'SYSTEM'].includes(origin);
}

export function isValidHistoryOrigin(origin) {
  return historyOrigins.has(origin);
}
