import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  canonicalStageForBindingStages,
  classifyMqlEvidence,
  isMetaOutboundEligibleByStageTruth,
  STAGE_SOURCES,
  STAGE_VERIFICATION_STATUSES,
} from '../src/stage-truth.js';

const db = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../sql/016_wa2_stage_truth_manual_requests.sql', import.meta.url), 'utf8');
const views = fs.readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');

test('classifica etiqueta qualificadora única como válida', () => {
  assert.equal(classifyMqlEvidence({ qualifyingLabelCount: 1, activeQualifyingLabelCount: 1, anyWaEvidence: true }), 'VALID_LABEL_CONFIRMED');
});

test('classifica ausência de etiqueta e etiqueta removida', () => {
  assert.equal(classifyMqlEvidence({ anyWaEvidence: true }), 'INVALID_NO_QUALIFYING_LABEL');
  assert.equal(classifyMqlEvidence({ qualifyingLabelCount: 1, qualifyingLabelRemovedBeforeEvent: true, anyWaEvidence: true }), 'INVALID_LABEL_REMOVED_BEFORE_EVENT');
});

test('classifica inferência de stage, reconciliação e falta de evidência', () => {
  assert.equal(classifyMqlEvidence({ stageOnly: true }), 'INVALID_STAGE_ONLY');
  assert.equal(classifyMqlEvidence({ reconciliationEvidence: true, anyWaEvidence: true }), 'INVALID_RECONCILIATION_ASSUMPTION');
  assert.equal(classifyMqlEvidence(), 'AMBIGUOUS_NO_WA_EVIDENCE');
});

test('classifica teste interno, múltiplas etiquetas e manual em duas etapas', () => {
  assert.equal(classifyMqlEvidence({ internalTest: true }), 'INVALID_INTERNAL_TEST');
  assert.equal(classifyMqlEvidence({ multipleLabels: true, activeQualifyingLabelCount: 2 }), 'AMBIGUOUS_MULTIPLE_LABELS');
  assert.equal(classifyMqlEvidence({ manualTwoStep: true, activeQualifyingLabelCount: 1 }), 'VALID_MANUAL_TWO_STEP');
});

test('Meta só é elegível quando a fonte é etiqueta WhatsApp verificada', () => {
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.WHATSAPP_LABEL, stage_verification_status: STAGE_VERIFICATION_STATUSES.VERIFIED }), true);
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.LEGACY_UNVERIFIED, stage_verification_status: STAGE_VERIFICATION_STATUSES.VERIFIED }), false);
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.WHATSAPP_LABEL, stage_verification_status: STAGE_VERIFICATION_STATUSES.UNVERIFIED_NO_LABEL }), false);
});

test('migration de fonte de verdade é aditiva e audita eventos sem apagar histórico', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS stage_source/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS validity_status/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS manual_stage_change_requests/);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|DATABASE|SCHEMA)|\bTRUNCATE\b/i);
  assert.match(migration, /MQL_INVALIDATED/);
});

test('solicitação manual não chama moveLeadStage e exige receipt para completar', () => {
  assert.match(db, /export async function createManualStageChangeRequest/);
  assert.match(db, /MANUAL_STAGE_REQUESTED/);
  assert.match(db, /MANUAL_STAGE_APPROVED/);
  assert.match(db, /status = 'COMPLETED'/);
  assert.match(db, /completeManualStageRequestForReceipt/);
  assert.match(db, /stage_source = 'WHATSAPP_LABEL'/);
});

test('solicitante não pode aprovar sem emergency override auditável', () => {
  assert.match(db, /MANUAL_STAGE_SELF_APPROVAL/);
  assert.match(db, /APPROVE_EMERGENCY_STAGE_CHANGE/);
  assert.match(db, /emergencyOverride/);
});

test('evento invalidado não bloqueia ocorrência futura idempotente', () => {
  assert.match(db, /validity_status !== 'INVALIDATED'/);
  assert.match(db, /:occ:/);
  assert.match(db, /validity_status = 'INVALIDATED'/);
});

test('backfill, reconciliação e claim Meta permanecem bloqueados', () => {
  assert.match(db, /META_HISTORICAL_BACKFILL_DISABLED/);
  assert.match(db, /WA2_RECONCILIATION_DISABLED/);
  assert.match(db, /WA2_DAILY_RECONCILIATION_ENABLED !== 'true'/);
  assert.match(db, /blocked_event\.validity_status = 'VALID'/);
  assert.match(db, /blocked_lead\.stage_source = 'WHATSAPP_LABEL'/);
});

test('interface não oferece mudança direta e mostra a fonte da etapa', () => {
  assert.match(views, /stage-request/);
  assert.match(views, /Motivo/);
  assert.match(views, /Fonte:/);
  assert.match(views, /Sem etiqueta de etapa no WhatsApp/);
  assert.match(views, /MQL invalidado localmente/);
});

test('tenant e request id são usados nas ações administrativas', () => {
  assert.match(db, /manual_stage_change_requests[\s\S]*tenant_id = \$1/);
  assert.match(db, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, lead_id\)/);
});

test('CRM01 canônica todas as variantes neutras para IN_SERVICE', () => {
  assert.equal(canonicalStageForBindingStages(['NEW', 'CONTACT_STARTED', 'NO_RESPONSE', 'IN_SERVICE']), 'IN_SERVICE');
});

test('CRM02 canônica para QUALIFIED', () => {
  assert.equal(canonicalStageForBindingStages(['QUALIFIED']), 'QUALIFIED');
});

test('CRM03 canônica para NEGOTIATING', () => {
  assert.equal(canonicalStageForBindingStages(['NEGOTIATING']), 'NEGOTIATING');
});

test('CRM04 canônica variantes de oportunidade para OPPORTUNITY', () => {
  assert.equal(canonicalStageForBindingStages(['OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']), 'OPPORTUNITY');
});

test('CRM05 preserva terminal PAID sobre ENROLLED', () => {
  assert.equal(canonicalStageForBindingStages(['ENROLLED', 'PAID']), 'PAID');
});

test('CRM99 canônica perdas para LOST', () => {
  assert.equal(canonicalStageForBindingStages(['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED']), 'LOST');
});

test('binding desconhecido não escolhe etapa por aproximação', () => {
  assert.equal(canonicalStageForBindingStages(['UNKNOWN_BINDING']), null);
});

test('etiqueta CRM01 controla etapa sem criar MQL', () => {
  assert.equal(canonicalStageForBindingStages(['IN_SERVICE']), 'IN_SERVICE');
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.WHATSAPP_LABEL, stage_verification_status: STAGE_VERIFICATION_STATUSES.VERIFIED }), true);
});

test('etiqueta ausente mantém lead não verificado para Meta', () => {
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.LEGACY_UNVERIFIED, stage_verification_status: STAGE_VERIFICATION_STATUSES.UNVERIFIED_NO_LABEL }), false);
});

test('etiquetas múltiplas não são fundidas em uma escolha arbitrária', () => {
  assert.equal(classifyMqlEvidence({ multipleLabels: true, activeQualifyingLabelCount: 2 }), 'AMBIGUOUS_MULTIPLE_LABELS');
});

test('identidade pendente não autoriza Meta', () => {
  assert.equal(isMetaOutboundEligibleByStageTruth({ stage_source: STAGE_SOURCES.MANUAL_TWO_STEP_APPROVED, stage_verification_status: STAGE_VERIFICATION_STATUSES.PENDING_WA_LABEL }), false);
});

test('MQL sem etiqueta é inválido localmente', () => {
  assert.equal(classifyMqlEvidence({ anyWaEvidence: true, activeQualifyingLabelCount: 0 }), 'INVALID_NO_QUALIFYING_LABEL');
});

test('MQL de teste interno permanece bloqueado', () => {
  assert.equal(classifyMqlEvidence({ internalTest: true, activeQualifyingLabelCount: 1 }), 'INVALID_INTERNAL_TEST');
});
