export class Wa2LinkRuleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'Wa2LinkRuleError';
    this.code = code;
  }
}

export function validateWa2LinkParents({
  tenantId,
  lead,
  instance,
  expectedPhoneNormalized,
}) {
  if (!tenantId) {
    throw new Wa2LinkRuleError('Tenant obrigatório', 'WA2_TENANT_REQUIRED');
  }
  if (!lead) {
    throw new Wa2LinkRuleError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');
  }
  if (lead.tenant_id !== tenantId) {
    throw new Wa2LinkRuleError('Lead pertence a outro tenant', 'WA2_TENANT_CONFLICT');
  }
  if (!lead.phone_normalized || lead.phone_normalized !== expectedPhoneNormalized) {
    throw new Wa2LinkRuleError(
      'O telefone do lead mudou durante a confirmação',
      'WA2_LEAD_PHONE_CHANGED',
    );
  }
  if (!instance) {
    throw new Wa2LinkRuleError(
      'Instância local não encontrada',
      'WA2_INSTANCE_NOT_FOUND',
    );
  }
  if (instance.tenant_id !== tenantId) {
    throw new Wa2LinkRuleError('Instância pertence a outro tenant', 'WA2_TENANT_CONFLICT');
  }
  if (!instance.enabled) {
    throw new Wa2LinkRuleError(
      'Instância local está desabilitada',
      'WA2_INSTANCE_DISABLED',
    );
  }
  return { lead, instance };
}

export function assertNoActiveWa2LinkConflict(rows) {
  if (rows.length > 0) {
    throw new Wa2LinkRuleError(
      'Já existe vínculo WA2 conflitante',
      'WA2_LINK_CONFLICT',
    );
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateWa2ConfirmationState({
  expectedAction,
  expectedLinkId,
  currentLink,
}) {
  if (!['CREATE', 'REPLACE'].includes(expectedAction)) {
    throw new Wa2LinkRuleError(
      'Ação de confirmação inválida',
      'WA2_CONFIRMATION_INVALID',
    );
  }
  if (expectedAction === 'CREATE' && expectedLinkId !== null) {
    throw new Wa2LinkRuleError(
      'Identificador de vínculo inesperado para criação',
      'WA2_CONFIRMATION_INVALID',
    );
  }
  if (
    expectedAction === 'REPLACE' &&
    !UUID_PATTERN.test(expectedLinkId || '')
  ) {
    throw new Wa2LinkRuleError(
      'Identificador de vínculo obrigatório para substituição',
      'WA2_CONFIRMATION_INVALID',
    );
  }
  if (
    (expectedAction === 'CREATE' && currentLink) ||
    (expectedAction === 'REPLACE' && currentLink?.id !== expectedLinkId)
  ) {
    throw new Wa2LinkRuleError(
      'O vínculo ativo mudou após a resolução inicial',
      'WA2_LINK_CHANGED',
    );
  }
  return expectedAction;
}
