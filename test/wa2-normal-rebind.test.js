import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WA2_CURRENT_LABEL_EVIDENCE_TYPES,
  WA2_NORMAL_CHAT_REBIND_REASON,
  normalRebindPayloadHash,
  validateCurrentLabelEvidence,
} from '../src/wa2-rebind.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
const db = read('src/db.js');
const migration = read('sql/018_wa2_current_label_confirmation.sql');
const script = read('scripts/rebind-normal-lead-crm02.mjs');

const baseEvidence = {
  tenantId: 'super-educar',
  leadId: 'lead-1',
  instanceId: 'wa-instance-1',
  chatId: 'chat-current',
  contactId: 'contact-current',
  remoteLabelId: '36',
  remoteLabelName: 'CRM 02 - Qualificado',
  operation: 'APPLY',
  observedAt: '2026-08-05T03:00:00.000Z',
  evidenceType: 'WA2_LABEL_APPLY_EVENT',
  evidenceReference: 'event-apply-1',
  sourceEventId: 'event-apply-1',
};

test('estado atual aceita lead normal sem mensagem ou waMessageId', () => {
  for (const evidenceType of WA2_CURRENT_LABEL_EVIDENCE_TYPES) {
    const evidence = validateCurrentLabelEvidence({
      ...baseEvidence,
      evidenceType,
      sourceEventId: evidenceType === 'WA2_LABEL_APPLY_EVENT' ? baseEvidence.sourceEventId : null,
    });
    assert.equal(evidence.evidenceType, evidenceType);
  }
});

test('estado atual exige APPLY e evento para evidência de APPLY', () => {
  assert.throws(() => validateCurrentLabelEvidence({ ...baseEvidence, operation: 'REMOVE' }));
  assert.throws(() => validateCurrentLabelEvidence({ ...baseEvidence, sourceEventId: null }));
  assert.throws(() => validateCurrentLabelEvidence({ ...baseEvidence, evidenceType: 'WA2_MESSAGE' }));
});

test('payload do rebind normal é determinístico e muda com a evidência', () => {
  const first = normalRebindPayloadHash({
    leadId: 'lead',
    instanceId: 'instance',
    expectedActiveLinkId: 'old-link',
    expectedOldRemoteChatId: 'old-chat',
    newRemoteChatId: 'new-chat',
    newRemoteContactId: 'new-contact',
    newRemoteJid: '5538999990000@s.whatsapp.net',
    canonicalPhone: '5538999990000',
    pn: '5538999990000@s.whatsapp.net',
    lid: 'lid-1@lid',
    remoteLabelId: '36',
    remoteLabelName: 'CRM 02 - Qualificado',
    evidenceType: 'WA2_LABEL_APPLY_EVENT',
    evidenceReference: 'event-1',
    sourceEventId: 'event-1',
    remoteInstanceId: 'remote-instance',
    observedAt: baseEvidence.observedAt,
    reason: WA2_NORMAL_CHAT_REBIND_REASON,
    idempotencyKey: 'wa2-normal-rebind:test-key',
  });
  assert.equal(first, normalRebindPayloadHash({
    leadId: 'lead',
    instanceId: 'instance',
    expectedActiveLinkId: 'old-link',
    expectedOldRemoteChatId: 'old-chat',
    newRemoteChatId: 'new-chat',
    newRemoteContactId: 'new-contact',
    newRemoteJid: '5538999990000@s.whatsapp.net',
    canonicalPhone: '5538999990000',
    pn: '5538999990000@s.whatsapp.net',
    lid: 'lid-1@lid',
    remoteLabelId: '36',
    remoteLabelName: 'CRM 02 - Qualificado',
    evidenceType: 'WA2_LABEL_APPLY_EVENT',
    evidenceReference: 'event-1',
    sourceEventId: 'event-1',
    remoteInstanceId: 'remote-instance',
    observedAt: baseEvidence.observedAt,
    reason: WA2_NORMAL_CHAT_REBIND_REASON,
    idempotencyKey: 'wa2-normal-rebind:test-key',
  }));
});

test('migration do estado atual é aditiva e protege unicidade', () => {
  assert.doesNotMatch(migration, /\b(DROP TABLE|DELETE FROM|TRUNCATE)\b/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wa2_current_label_confirmations/);
  assert.match(migration, /wa2_current_label_confirmations_key_uidx/);
  assert.match(migration, /wa2_current_label_confirmations_lead_stage_uidx/);
  assert.match(migration, /WA2_CURRENT_LABEL_STATE_CONFIRMED/);
  assert.match(migration, /WA2_CURRENT_LABEL_STATE/);
  assert.match(migration, /WA2_LABEL_APPLY_EVENT/);
});

test('rebind normal preserva vínculo antigo e não cria receipt ou Meta', () => {
  const start = db.indexOf('export async function rebindNormalLeadToCurrentWa2Chat');
  const end = db.indexOf('export async function confirmCurrentWa2LabelStateAndAlignLead', start);
  const source = db.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /BEGIN/);
  assert.match(source, /UPDATE wa2_contact_links/);
  assert.match(source, /INSERT INTO wa2_contact_links/);
  assert.match(source, /WA2_NORMAL_REBIND_REASON/);
  assert.doesNotMatch(source, /INSERT INTO wa2_label_event_receipts/);
  assert.doesNotMatch(source, /meta_conversion_events/);
  assert.doesNotMatch(source, /meta_jobs/);
  assert.match(source, /status: 'ALREADY_REBOUND'/);
});

test('confirmação atual é separada do receipt e alinha somente NEW para QUALIFIED', () => {
  const start = db.indexOf('export async function confirmCurrentWa2LabelStateAndAlignLead');
  const end = db.indexOf('async function createOrGetMetaEvent', start);
  const source = db.slice(start, end);
  assert.match(source, /WA2_CURRENT_LABEL_CONFIRMATION_ACTIVITY/);
  assert.match(source, /INSERT INTO wa2_current_label_confirmations/);
  assert.match(source, /UPDATE leads SET stage = 'QUALIFIED'/);
  assert.match(source, /stage_source = 'WHATSAPP_LABEL'/);
  assert.match(source, /stage_verification_status = 'VERIFIED'/);
  assert.match(source, /status: 'ALREADY_CONFIRMED'/);
  assert.doesNotMatch(source, /INSERT INTO wa2_label_event_receipts/);
  assert.doesNotMatch(source, /ensureMetaEventForStage/);
});

test('script é exclusivo do lead CRM02 e não usa mensagem ou envio', () => {
  assert.match(script, /a1d7206f-4de2-4205-95d5-de3184904940/);
  assert.match(script, /fd402cac-8777-4c2a-a623-7f44775619e0/);
  assert.match(script, /2026-08-04T18:01:36\.122Z/);
  assert.match(script, /listWa2LabeledIdentities/);
  assert.doesNotMatch(script, /getWa2ContactByPhone/);
  assert.match(script, /WA2_LABEL_APPLY_EVENT/);
  assert.match(script, /waMessageIdCreated: false/);
  assert.doesNotMatch(script, /sendWa2ChatMessage/);
  assert.doesNotMatch(script, /processWa2LabelEvent/);
});
