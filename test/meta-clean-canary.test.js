import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMetaCleanMqlCanary,
  META_CLEAN_DATASET_ID,
  META_LEGACY_DATASET_ID,
} from '../src/meta-clean-canary.js';

test('canário lógico usa apenas o dataset limpo e o horário observado', () => {
  const envelope = buildMetaCleanMqlCanary({
    tenantId: 'super-educar',
    metaLeadId: '1968345320512710',
    eventTime: '2026-08-05T15:00:00.000Z',
    confirmationId: 'wa2-current-label:lead-1:occurrence-1',
  });
  assert.equal(envelope.dataset_id, META_CLEAN_DATASET_ID);
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].event_name, 'Marketing Qualified Lead');
  assert.equal(envelope.data[0].event_time, 1785942000);
  assert.equal(envelope.data[0].action_source, 'system_generated');
  assert.equal(envelope.data[0].user_data.lead_id, '1968345320512710');
  assert.match(envelope.data[0].event_id, new RegExp(META_CLEAN_DATASET_ID));
  assert.match(envelope.data[0].event_id, /occurrence-1/);
  assert.doesNotMatch(envelope.data[0].event_id, new RegExp(META_LEGACY_DATASET_ID));
});

test('canário rejeita dataset legado e entrada inválida', () => {
  assert.throws(() => buildMetaCleanMqlCanary({
    tenantId: 'super-educar',
    metaLeadId: '1',
    eventTime: '2026-08-05T15:00:00.000Z',
    confirmationId: 'occurrence-1',
    datasetId: META_LEGACY_DATASET_ID,
  }), { message: 'META_CLEAN_DATASET_INVALID' });
  assert.throws(() => buildMetaCleanMqlCanary({
    tenantId: 'super-educar',
    metaLeadId: '1',
    eventTime: '2026-08-05T15:00:00.000Z',
    confirmationId: 'occurrence-1',
    datasetId: 'legacy-fallback',
  }), { message: 'META_CLEAN_DATASET_INVALID' });
});

test('helper do canário não possui efeitos de rede ou persistência', () => {
  const source = String(buildMetaCleanMqlCanary);
  assert.doesNotMatch(source, /fetch|axios|pool|INSERT|UPDATE|meta_jobs|meta_conversion_events/);
});
