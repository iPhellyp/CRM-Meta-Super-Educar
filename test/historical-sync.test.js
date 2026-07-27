import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalInboundStage,
  decideInboundLabelAction,
  historicalRetryDelayMs,
  reconciliationFailureResult,
} from '../src/historical-sync.js';

const baseEvent = {
  source: 'WHATSAPP',
  operation: 'APPLY',
  eligibleForCrm: true,
};

test('CRM 01 transforma NEW em CONTACTED e não repete CONTACTED', () => {
  assert.equal(canonicalInboundStage(['NEW', 'CONTACTED']), 'CONTACTED');
  assert.deepEqual(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'NEW',
      eventBindingStages: ['NEW', 'CONTACTED'],
      currentCrmLabelStages: [['NEW', 'CONTACTED']],
    }),
    {
      action: 'STAGE_CHANGED',
      code: 'OFFICIAL_TRANSITION',
      targetStage: 'CONTACTED',
    },
  );
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'CONTACTED',
      eventBindingStages: ['NEW', 'CONTACTED'],
      currentCrmLabelStages: [['NEW', 'CONTACTED']],
    }).action,
    'NOOP',
  );
});

test('CRM 02, 03 e 04 avançam somente por transições oficiais', () => {
  for (const [currentStage, targetStage] of [
    ['CONTACTED', 'QUALIFIED'],
    ['QUALIFIED', 'VESTIBULAR_REGISTERED'],
    ['VESTIBULAR_REGISTERED', 'VESTIBULAR_COMPLETED'],
  ]) {
    assert.equal(
      decideInboundLabelAction({
        event: baseEvent,
        currentStage,
        eventBindingStages: [targetStage],
        currentCrmLabelStages: [[targetStage]],
      }).action,
      'STAGE_CHANGED',
    );
  }
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'NEW',
      eventBindingStages: ['QUALIFIED'],
      currentCrmLabelStages: [['QUALIFIED']],
    }).code,
    'OFFICIAL_TRANSITION_NOT_ALLOWED',
  );
});

test('CRM 05 cria confirmação e nunca matricula automaticamente', () => {
  const result = decideInboundLabelAction({
    event: baseEvent,
    currentStage: 'VESTIBULAR_COMPLETED',
    eventBindingStages: ['MATRICULATED'],
    currentCrmLabelStages: [['MATRICULATED']],
  });
  assert.equal(result.action, 'PENDING_CONFIRMATION');
  assert.equal(result.targetStage, 'MATRICULATED');
});

test('CRM 99 respeita transição oficial e conflito quando bloqueada', () => {
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'QUALIFIED',
      eventBindingStages: ['LOST'],
      currentCrmLabelStages: [['LOST']],
    }).action,
    'STAGE_CHANGED',
  );
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'MATRICULATED',
      eventBindingStages: ['LOST'],
      currentCrmLabelStages: [['LOST']],
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

test('múltiplas etiquetas CRM não escolhem etapa automaticamente', () => {
  assert.equal(
    decideInboundLabelAction({
      event: baseEvent,
      currentStage: 'CONTACTED',
      eventBindingStages: ['QUALIFIED'],
      currentCrmLabelStages: [['QUALIFIED'], ['VESTIBULAR_REGISTERED']],
    }).code,
    'MULTIPLE_CRM_STAGE_LABELS',
  );
});

test('backoff é limitado e erros de reconciliação são categorizados', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8].map(historicalRetryDelayMs),
    [60_000, 300_000, 900_000, 3_600_000, 3_600_000],
  );
  assert.equal(reconciliationFailureResult({ remoteCode: 'WA2_LID_UNRESOLVED' }), 'LID');
  assert.equal(reconciliationFailureResult({ remoteCode: 'WA2_CONTACT_AMBIGUOUS' }), 'AMBIGUOUS');
  assert.equal(reconciliationFailureResult({ code: 'other' }), 'FAILED');
});
