import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_ORIGINS,
  STAGES,
  canTransition,
  getStageActions,
  getStageEventName,
  isKnownStage,
  isValidHistoryOrigin,
} from '../src/funnel.js';

const allowedTransitions = [
  [STAGES.NEW, STAGES.CONTACTED],
  [STAGES.CONTACTED, STAGES.QUALIFIED],
  [STAGES.CONTACTED, STAGES.LOST],
  [STAGES.QUALIFIED, STAGES.VESTIBULAR_REGISTERED],
  [STAGES.QUALIFIED, STAGES.LOST],
  [STAGES.VESTIBULAR_REGISTERED, STAGES.VESTIBULAR_COMPLETED],
  [STAGES.VESTIBULAR_REGISTERED, STAGES.LOST],
  [STAGES.VESTIBULAR_COMPLETED, STAGES.MATRICULATED],
  [STAGES.VESTIBULAR_COMPLETED, STAGES.LOST],
  [STAGES.LOST, STAGES.CONTACTED],
];

test('aceita todas as transições oficiais do funil', () => {
  for (const [previousStage, newStage] of allowedTransitions) {
    assert.equal(canTransition(previousStage, newStage), true);
  }
});

test('todas as ações da interface representam transições permitidas', () => {
  for (const stage of Object.values(STAGES)) {
    for (const action of getStageActions(stage)) {
      assert.equal(canTransition(stage, action.stage), true);
    }
  }
});

test('rejeita transições arbitrárias e estágio desconhecido', () => {
  assert.equal(canTransition(STAGES.NEW, STAGES.QUALIFIED), false);
  assert.equal(canTransition(STAGES.CONTACTED, STAGES.MATRICULATED), false);
  assert.equal(canTransition(STAGES.LOST, STAGES.QUALIFIED), false);
  assert.equal(canTransition('UNKNOWN', STAGES.CONTACTED), false);
  assert.equal(canTransition(STAGES.NEW, 'UNKNOWN'), false);
  assert.equal(isKnownStage('UNKNOWN'), false);
});

test('mantém MATRICULATED como etapa final', () => {
  assert.deepEqual(getStageActions(STAGES.MATRICULATED), []);
  for (const stage of Object.values(STAGES)) {
    assert.equal(canTransition(STAGES.MATRICULATED, stage), false);
  }
});

test('LOST retorna somente para CONTACTED', () => {
  assert.deepEqual(getStageActions(STAGES.LOST), [
    { stage: STAGES.CONTACTED, label: 'Reativar atendimento' },
  ]);
});

test('OPPORTUNITY mantém somente a compatibilidade temporária definida', () => {
  assert.equal(canTransition(STAGES.OPPORTUNITY, STAGES.MATRICULATED), true);
  assert.equal(canTransition(STAGES.OPPORTUNITY, STAGES.LOST), true);
  assert.equal(canTransition(STAGES.OPPORTUNITY, STAGES.CONTACTED), false);
  assert.equal(canTransition(STAGES.OPPORTUNITY, STAGES.VESTIBULAR_COMPLETED), false);
});

test('mapeia somente os eventos Meta positivos oficiais', () => {
  assert.equal(getStageEventName(STAGES.QUALIFIED), 'Marketing Qualified Lead');
  assert.equal(getStageEventName(STAGES.VESTIBULAR_REGISTERED), null);
  assert.equal(getStageEventName(STAGES.VESTIBULAR_COMPLETED), 'Sales Opportunity');
  assert.equal(getStageEventName(STAGES.MATRICULATED), 'Converted');
  assert.equal(getStageEventName(STAGES.LOST), null);
  assert.equal(getStageEventName(STAGES.NEW), null);
  assert.equal(getStageEventName(STAGES.CONTACTED), null);
});

test('aceita somente origens de histórico reconhecidas', () => {
  for (const origin of HISTORY_ORIGINS) {
    assert.equal(isValidHistoryOrigin(origin), true);
  }
  assert.equal(isValidHistoryOrigin('UNKNOWN'), false);
  assert.equal(isValidHistoryOrigin(''), false);
  assert.equal(isValidHistoryOrigin(null), false);
});
