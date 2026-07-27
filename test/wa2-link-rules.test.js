import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoActiveWa2LinkConflict,
  validateWa2ConfirmationState,
  validateWa2LinkParents,
} from '../src/wa2-link-rules.js';

const TENANT_ID = 'super-educar';
const LEAD = Object.freeze({
  id: 'lead-1',
  tenant_id: TENANT_ID,
  phone_normalized: '5538999990000',
  stage: 'QUALIFIED',
  meta_lead_id: 'meta-1',
});
const INSTANCE = Object.freeze({
  id: 'instance-1',
  tenant_id: TENANT_ID,
  enabled: true,
});

function validate(overrides = {}) {
  return validateWa2LinkParents({
    tenantId: TENANT_ID,
    lead: LEAD,
    instance: INSTANCE,
    expectedPhoneNormalized: '5538999990000',
    ...overrides,
  });
}

test('aceita pais do vínculo no mesmo tenant sem alterar lead ou Meta', () => {
  const leadBefore = structuredClone(LEAD);
  const result = validate();
  assert.equal(result.lead, LEAD);
  assert.equal(result.instance, INSTANCE);
  assert.deepEqual(LEAD, leadBefore);
  assert.equal(LEAD.stage, 'QUALIFIED');
  assert.equal(LEAD.meta_lead_id, 'meta-1');
});

test('exige tenant e rejeita lead ou instância de outro tenant', () => {
  assert.throws(() => validate({ tenantId: '' }), { code: 'WA2_TENANT_REQUIRED' });
  assert.throws(() => validate({
    lead: { ...LEAD, tenant_id: 'outro-tenant' },
  }), { code: 'WA2_TENANT_CONFLICT' });
  assert.throws(() => validate({
    instance: { ...INSTANCE, tenant_id: 'outro-tenant' },
  }), { code: 'WA2_TENANT_CONFLICT' });
});

test('rejeita instância desabilitada', () => {
  assert.throws(() => validate({
    instance: { ...INSTANCE, enabled: false },
  }), { code: 'WA2_INSTANCE_DISABLED' });
});

test('rejeita telefone alterado entre resolução e confirmação', () => {
  assert.throws(() => validate({
    lead: { ...LEAD, phone_normalized: '553833330000' },
  }), { code: 'WA2_LEAD_PHONE_CHANGED' });
});

test('rejeita conflito ativo por lead ou chat', () => {
  assert.doesNotThrow(() => assertNoActiveWa2LinkConflict([]));
  assert.throws(() => assertNoActiveWa2LinkConflict([{
    id: 'link-1',
    lead_id: 'lead-1',
    remote_chat_id: 'chat-1',
  }]), { code: 'WA2_LINK_CONFLICT' });
});

test('confirma criação ou substituição somente no estado aprovado', () => {
  const expectedLinkId = '11111111-1111-4111-8111-111111111111';
  assert.equal(validateWa2ConfirmationState({
    expectedAction: 'CREATE',
    expectedLinkId: null,
    currentLink: null,
  }), 'CREATE');
  assert.equal(validateWa2ConfirmationState({
    expectedAction: 'REPLACE',
    expectedLinkId,
    currentLink: { id: expectedLinkId },
  }), 'REPLACE');
  assert.throws(() => validateWa2ConfirmationState({
    expectedAction: 'CREATE',
    expectedLinkId: null,
    currentLink: { id: expectedLinkId },
  }), { code: 'WA2_LINK_CHANGED' });
  assert.throws(() => validateWa2ConfirmationState({
    expectedAction: 'REPLACE',
    expectedLinkId,
    currentLink: null,
  }), { code: 'WA2_LINK_CHANGED' });
  assert.throws(() => validateWa2ConfirmationState({
    expectedAction: 'REPLACE',
    expectedLinkId,
    currentLink: { id: '22222222-2222-4222-8222-222222222222' },
  }), { code: 'WA2_LINK_CHANGED' });
  assert.throws(() => validateWa2ConfirmationState({
    expectedAction: 'CREATE',
    expectedLinkId,
    currentLink: null,
  }), { code: 'WA2_CONFIRMATION_INVALID' });
});
