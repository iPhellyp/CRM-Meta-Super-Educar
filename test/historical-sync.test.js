import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalInboundStage,
  decideInboundLabelAction,
  historicalRetryDelayMs,
  reconciliationFailureResult,
  sanitizeHistoricalError,
} from '../src/historical-sync.js';

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

test('INTERNAL_API evita loop, REMOVE não retrocede e UNKNOWN conflita', () => {
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
    'CONFLICT',
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
