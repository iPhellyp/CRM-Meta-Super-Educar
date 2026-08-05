import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalInboundStage,
  canAdvanceByOfficialCrmLabel,
  canCreateMetaForStage,
  classifyWa2LinkResolution,
  decideInboundLabelAction,
  evaluateExclusiveStageTransition,
  officialCrmLabelStageFor,
  historicalRetryDelayMs,
  reconciliationFailureResult,
  sanitizeHistoricalError,
} from '../src/historical-sync.js';

test('MQL e oportunidade exigem evidência da etiqueta oficial WA2', () => {
  for (const stage of ['QUALIFIED', 'NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']) {
    assert.equal(canCreateMetaForStage(stage, false), false, stage);
    assert.equal(canCreateMetaForStage(stage, true), true, stage);
  }
  for (const stage of ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE', 'ENROLLED', 'PAID', 'LOST', 'DUPLICATED']) {
    assert.equal(canCreateMetaForStage(stage, true), false, stage);
  }
});

test('classifica a causa do vínculo WA2 sem criar vínculo implícito', () => {
  const cases = [
    [{ instanceConfigured: false }, 'INSTANCE_MISMATCH'],
    [{ instanceConfigured: true, linkCount: 2 }, 'CHAT_LINK_MULTIPLE'],
    [{ instanceConfigured: true, jid: '123@lid' }, 'LID_UNRESOLVED'],
    [{ instanceConfigured: true, phoneNormalized: null, jid: 'x@s.whatsapp.net' }, 'LEAD_PHONE_NOT_FOUND'],
    [{ instanceConfigured: true, phoneNormalized: '5511999999999', leadCount: 0 }, 'LEAD_PHONE_NOT_FOUND'],
    [{ instanceConfigured: true, phoneNormalized: '5511999999999', leadCount: 2 }, 'LEAD_PHONE_MULTIPLE'],
    [{ instanceConfigured: true, phoneNormalized: '5511999999999', leadCount: 1, otherChatLinkCount: 1 }, 'REMOTE_CHAT_MULTIPLE'],
    [{ instanceConfigured: true, phoneNormalized: '5511999999999', leadCount: 1 }, 'CHAT_LINK_NOT_FOUND'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyWa2LinkResolution(input), expected);
  assert.equal(classifyWa2LinkResolution({ instanceConfigured: true, linkCount: 1 }), null);
});

const baseEvent = {
  source: 'WHATSAPP',
  operation: 'APPLY',
  eligibleForCrm: true,
};

test('grupo CRM 01 converge para Em atendimento', () => {
  assert.equal(
    canonicalInboundStage(['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE']),
    'IN_SERVICE',
  );
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'CONTACT_STARTED',
      eventBindingStages: ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'],
      currentCrmLabelStages: [['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE']],
    }).action,
    'STAGE_CHANGED',
  );
});

test('grupos CRM 02, 03, 04 e 05 convergem corretamente', () => {
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'IN_SERVICE',
      eventBindingStages: ['QUALIFIED'],
      currentCrmLabelStages: [['QUALIFIED']],
    }).targetStage,
    'QUALIFIED',
  );

  assert.equal(
    canonicalInboundStage(['NEGOTIATING']),
    'NEGOTIATING',
  );

  assert.equal(
    canonicalInboundStage([
      'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT',
    ]),
    'OPPORTUNITY',
  );

  assert.equal(
    canonicalInboundStage(['ENROLLED', 'PAID']),
    'ENROLLED',
  );
});

test('duas etiquetas comerciais conflitantes exigem revisão', () => {
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'IN_SERVICE',
      eventBindingStages: ['QUALIFIED'],
      currentCrmLabelStages: [['QUALIFIED'], ['OPPORTUNITY']],
    }).code,
    'MULTIPLE_CRM_STAGE_LABELS',
  );
});

test('CRM01 + CRM02 é uma transição exclusiva válida somente com evidência ordenada', () => {
  assert.equal(officialCrmLabelStageFor('IN_SERVICE'), 'IN_SERVICE');
  const result = decideInboundLabelAction({
    event: baseEvent,
    currentStage: 'IN_SERVICE',
    eventBindingStages: ['QUALIFIED'],
    currentCrmLabelStages: [
      ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'],
      ['QUALIFIED'],
    ],
    previousLabelObservedAt: '2026-08-04T20:43:52.400Z',
    eventObservedAt: '2026-08-04T20:44:03.400Z',
    identityMatch: true,
    linkMatch: true,
  });
  assert.equal(result.action, 'STAGE_CHANGED');
  assert.equal(result.exclusiveTransition, true);
  assert.equal(result.transitionEvidence.validTransition, true);
  assert.deepEqual(
    evaluateExclusiveStageTransition({
      currentStage: 'IN_SERVICE',
      targetStage: 'QUALIFIED',
      currentCrmLabelStages: [
        ['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE'],
        ['QUALIFIED'],
      ],
      previousLabelObservedAt: '2026-08-04T20:43:52.400Z',
      eventObservedAt: '2026-08-04T20:44:03.400Z',
      identityMatch: true,
      linkMatch: true,
    }),
    {
      currentStage: 'IN_SERVICE',
      targetStage: 'QUALIFIED',
      previousLabelMatchesCurrentStage: true,
      thirdStageLabels: 0,
      identityMatch: true,
      linkMatch: true,
      eventLater: true,
      validTransition: true,
    },
  );
});

test('transição exclusiva rejeita evento fora de ordem, vínculo ausente ou terceira etapa', () => {
  const input = {
    event: baseEvent,
    currentStage: 'IN_SERVICE',
    eventBindingStages: ['QUALIFIED'],
    currentCrmLabelStages: [
      ['IN_SERVICE'],
      ['QUALIFIED'],
    ],
    previousLabelObservedAt: '2026-08-04T20:44:03.400Z',
    eventObservedAt: '2026-08-04T20:43:52.400Z',
  };
  assert.equal(decideInboundLabelAction(input).code, 'MULTIPLE_CRM_STAGE_LABELS');
  assert.equal(
    decideInboundLabelAction({
      ...input,
      previousLabelObservedAt: '2026-08-04T20:43:52.400Z',
      eventObservedAt: '2026-08-04T20:44:03.400Z',
      linkMatch: false,
    }).code,
    'MULTIPLE_CRM_STAGE_LABELS',
  );
  assert.equal(
    decideInboundLabelAction({
      ...input,
      previousLabelObservedAt: '2026-08-04T20:43:52.400Z',
      eventObservedAt: '2026-08-04T20:44:03.400Z',
      currentCrmLabelStages: [['IN_SERVICE'], ['QUALIFIED'], ['OPPORTUNITY']],
    }).code,
    'MULTIPLE_CRM_STAGE_LABELS',
  );
});

test('evento repetido depois da etapa correta não cria nova transição', () => {
  const result = decideInboundLabelAction({
    event: baseEvent,
    currentStage: 'QUALIFIED',
    eventBindingStages: ['QUALIFIED'],
    currentCrmLabelStages: [['IN_SERVICE'], ['QUALIFIED']],
  });
  assert.deepEqual(result, {
    action: 'NOOP',
    code: 'STAGE_ALREADY_CORRECT_LABEL_SYNC_PENDING_REMOVE',
    targetStage: 'QUALIFIED',
  });
});

test('CRM 05 é protegido e nunca confirma matrícula automaticamente pelo WA2', () => {
  for (const target of ['ENROLLED', 'PAID']) {
    const result = decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'AWAITING_PAYMENT',
      eventBindingStages: [target],
      currentCrmLabelStages: [[target]],
    });

    assert.equal(result.action, 'CONFLICT');
    assert.equal(result.code, 'PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION');
  }

  const sharedLabelResult = decideInboundLabelAction({
    event: baseEvent,
    currentStage: 'AWAITING_PAYMENT',
    eventBindingStages: ['ENROLLED', 'PAID'],
    currentCrmLabelStages: [['ENROLLED', 'PAID']],
  });

  assert.equal(sharedLabelResult.action, 'CONFLICT');
  assert.equal(
    sharedLabelResult.code,
    'PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION',
  );
  assert.equal(sharedLabelResult.targetStage, 'ENROLLED');

  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'PAID',
      eventBindingStages: ['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'],
      currentCrmLabelStages: [['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED']],
    }).action,
    'CONFLICT',
  );
});

test('INTERNAL_API evita loop, REMOVE não retrocede e UNKNOWN é técnico', () => {
  assert.equal(
    decideInboundLabelAction({
      event: { ...baseEvent, source: 'INTERNAL_API' },
      currentStage: 'NEW',
    }).code,
    'INTERNAL_API_LOOP_GUARD',
  );
  assert.equal(
    decideInboundLabelAction({
      event: { ...baseEvent, operation: 'REMOVE' },
      currentStage: 'QUALIFIED',
    }).code,
    'REMOVE_NO_REGRESSION',
  );
  assert.equal(
    decideInboundLabelAction({
      event: { ...baseEvent, source: 'UNKNOWN' },
      currentStage: 'NEW',
    }).action,
    'IGNORED',
  );
});

test('backoff é limitado e resultados de reconciliação são legíveis', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8].map(historicalRetryDelayMs),
    [60_000, 300_000, 900_000, 3_600_000, 3_600_000],
  );
  assert.equal(reconciliationFailureResult({ remoteCode: 'WA2_LID_UNRESOLVED' }), 'LID_UNRESOLVED');
  assert.equal(reconciliationFailureResult({ remoteCode: 'LID_UNRESOLVED' }), 'LID_UNRESOLVED');
  assert.equal(reconciliationFailureResult({ remoteCode: 'WA2_CONTACT_NOT_FOUND' }), 'NOT_FOUND_IN_WA2');
  assert.equal(reconciliationFailureResult({ code: 'other' }), 'ERROR');
});

test('etiquetas oficiais permitem apenas avanços comerciais diretos', () => {
  const cases = [
    ['NEW', 'QUALIFIED'], ['NEW', 'NEGOTIATING'], ['NEW', 'OPPORTUNITY'],
    ['QUALIFIED', 'NEGOTIATING'], ['QUALIFIED', 'OPPORTUNITY'],
    ['NEGOTIATING', 'OPPORTUNITY'],
  ];
  for (const [current, desired] of cases) {
    assert.equal(canAdvanceByOfficialCrmLabel(current, desired), true, `${current} -> ${desired}`);
    const result = decideInboundLabelAction({
      event: baseEvent,
      currentStage: current,
      eventBindingStages: [desired],
      currentCrmLabelStages: [[desired]],
    });
    assert.equal(result.action, 'STAGE_CHANGED', `${current} -> ${desired}: ${result.code}`);
  }
  assert.equal(canAdvanceByOfficialCrmLabel('OPPORTUNITY', 'QUALIFIED'), false);
  assert.equal(canAdvanceByOfficialCrmLabel('NEW', 'ENROLLED'), false);
});

test('erro histórico preserva causa remota e classifica HTTP sem mascarar', () => {
  assert.equal(
    sanitizeHistoricalError(
      { code: 'WA2_HTTP_ERROR', remoteCode: 'CONTACT_NOT_FOUND', status: 404 },
      'FALLBACK',
    ).code,
    'CONTACT_NOT_FOUND',
  );
  for (const [status, code] of [
    [404, 'WA2_API_ROUTE_NOT_FOUND'],
    [401, 'WA2_AUTHENTICATION_FAILED'],
    [403, 'WA2_AUTHORIZATION_FAILED'],
    [429, 'WA2_RATE_LIMITED'],
    [500, 'WA2_TEMPORARY_FAILURE'],
  ]) {
    assert.equal(
      sanitizeHistoricalError({ code: 'WA2_HTTP_ERROR', status }, 'FALLBACK').code,
      code,
    );
  }
});
