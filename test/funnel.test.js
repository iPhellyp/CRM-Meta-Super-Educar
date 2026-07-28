import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_ORIGINS,
  STAGES,
  canTransition,
  getStageActions,
  getStageEventName,
  isDirectStageTarget,
  isKnownStage,
  isValidHistoryOrigin,
  originMayConfirmProtectedStage,
} from '../src/funnel.js';

const allowedTransitions = [
  [STAGES.NEW, STAGES.CONTACT_STARTED],
  [STAGES.CONTACT_STARTED, STAGES.IN_SERVICE],
  [STAGES.IN_SERVICE, STAGES.QUALIFIED],
  [STAGES.QUALIFIED, STAGES.OPPORTUNITY],
  [STAGES.OPPORTUNITY, STAGES.NEGOTIATING],
  [STAGES.NEGOTIATING, STAGES.AWAITING_ENROLLMENT],
  [STAGES.AWAITING_ENROLLMENT, STAGES.AWAITING_PAYMENT],
  [STAGES.AWAITING_PAYMENT, STAGES.ENROLLED],
  [STAGES.ENROLLED, STAGES.PAID],
  [STAGES.QUALIFIED, STAGES.LOST],
  [STAGES.LOST, STAGES.CONTACT_STARTED],
];

test('aceita as transições comerciais oficiais', () => {
  for (const [previousStage, newStage] of allowedTransitions) {
    assert.equal(canTransition(previousStage, newStage), true);
  }
});

test('todas as ações manuais representam transições permitidas', () => {
  for (const stage of Object.values(STAGES)) {
    for (const action of getStageActions(stage)) {
      assert.equal(canTransition(stage, action.stage), true);
      assert.equal([STAGES.ENROLLED, STAGES.PAID].includes(action.stage), false);
    }
  }
});

test('matrícula e pagamento não são alvos manuais', () => {
  assert.equal(isDirectStageTarget(STAGES.ENROLLED), false);
  assert.equal(isDirectStageTarget(STAGES.PAID), false);
  assert.equal(originMayConfirmProtectedStage('SR_GESTAO'), true);
  assert.equal(originMayConfirmProtectedStage('SYSTEM'), true);
  assert.equal(originMayConfirmProtectedStage('MANUAL'), false);
});

test('PAID é final e ENROLLED só avança para PAID', () => {
  assert.deepEqual(getStageActions(STAGES.PAID), []);
  assert.equal(canTransition(STAGES.PAID, STAGES.LOST), false);
  assert.equal(canTransition(STAGES.ENROLLED, STAGES.LOST), false);
  assert.equal(canTransition(STAGES.ENROLLED, STAGES.PAID), true);
});

test('rejeita transições arbitrárias e estágio desconhecido', () => {
  assert.equal(canTransition(STAGES.NEW, STAGES.QUALIFIED), false);
  assert.equal(canTransition(STAGES.LOST, STAGES.QUALIFIED), false);
  assert.equal(canTransition('UNKNOWN', STAGES.CONTACT_STARTED), false);
  assert.equal(isKnownStage('UNKNOWN'), false);
});

test('mapeia somente eventos Meta positivos autorizados', () => {
  assert.equal(getStageEventName(STAGES.QUALIFIED), 'Marketing Qualified Lead');
  for (const stage of [
    STAGES.OPPORTUNITY,
    STAGES.NEGOTIATING,
    STAGES.AWAITING_ENROLLMENT,
    STAGES.AWAITING_PAYMENT,
  ]) {
    assert.equal(getStageEventName(stage), 'Sales Opportunity');
  }
  assert.equal(getStageEventName(STAGES.ENROLLED), null);
  assert.equal(getStageEventName(STAGES.PAID), 'Converted');
  assert.equal(getStageEventName(STAGES.LOST), null);
});

test('aceita somente origens de histórico reconhecidas', () => {
  for (const origin of HISTORY_ORIGINS) assert.equal(isValidHistoryOrigin(origin), true);
  assert.equal(isValidHistoryOrigin('UNKNOWN'), false);
  assert.equal(isValidHistoryOrigin(null), false);
});
