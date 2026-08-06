import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  compareStableWhatsAppIdentity,
  classifyWa2LinkCandidates,
  detectWa2InstanceReplacement,
  isWa2ReplacementEventAfterCutover,
  normalizeCanonicalWhatsAppPhone,
  normalizePnJid,
  planWa2InstanceReplacement,
  planWa2LabelRemap,
  WA2_REPLACEMENT_LABEL_NAMES,
} from '../src/wa2-instance-replacement.js';
import { wa2InstanceReplacementConfig } from '../src/wa2-instance-replacement-config.js';

const migration = await readFile(new URL('../sql/021_wa2_instance_replacement.sql', import.meta.url), 'utf8');
const dbSource = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
const serverSource = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const viewsSource = await readFile(new URL('../src/views.js', import.meta.url), 'utf8');
const runnerSource = await readFile(new URL('../src/wa2-instance-replacement-runner.js', import.meta.url), 'utf8');
const scriptSource = await readFile(new URL('../scripts/wa2-instance-replacement.mjs', import.meta.url), 'utf8');
const stackSource = await readFile(new URL('../docker-stack.yml', import.meta.url), 'utf8');
const deployDocs = await readFile(new URL('../docs/DEPLOY_PRODUCTION.md', import.meta.url), 'utf8');

const OLD_PHONE = '553888515846';
const CANONICAL_PHONE = '5538988515846';
const OLD_INSTANCE = { tenant_id: 'tenant-a', id: 'old', enabled: false, remote_status: 'REMOTE_DELETED', phone: OLD_PHONE };
const NEW_INSTANCE = { tenant_id: 'tenant-a', id: 'new', enabled: true, remote_status: 'CONNECTED', phone: CANONICAL_PHONE };
const OLD_STATUS = { status: 'DISCONNECTED', phone: OLD_PHONE };
const NEW_STATUS = { status: 'CONNECTED', phone: CANONICAL_PHONE };

function labelFixtures() {
  return Object.entries(WA2_REPLACEMENT_LABEL_NAMES).map(([code, name]) => ({ id: `label-${code}`, name }));
}

test('migration cria estrutura auditável sem apagar dados', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wa2_logical_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wa2_logical_account_generations/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wa2_instance_replacement_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS wa2_instance_replacement_items/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, current_wa2_instance_id\)/);
  assert.doesNotMatch(migration, /DROP\s+TABLE|DROP\s+CONSTRAINT|TRUNCATE|DELETE\s+FROM|UPDATE\s+/i);
});

test('feature flags são explicitamente opt-in e a execução exige os dois flags', () => {
  assert.deepEqual(wa2InstanceReplacementConfig({}), {
    enabled: false,
    executionEnabled: false,
  });
  assert.deepEqual(wa2InstanceReplacementConfig({
    WA2_INSTANCE_REPLACEMENT_ENABLED: 'true',
  }), {
    enabled: true,
    executionEnabled: false,
  });
  assert.deepEqual(wa2InstanceReplacementConfig({
    WA2_INSTANCE_REPLACEMENT_ENABLED: 'true',
    WA2_INSTANCE_REPLACEMENT_EXECUTION_ENABLED: 'true',
  }), {
    enabled: true,
    executionEnabled: true,
  });
  assert.equal(wa2InstanceReplacementConfig({
    WA2_INSTANCE_REPLACEMENT_ENABLED: 'false',
    WA2_INSTANCE_REPLACEMENT_EXECUTION_ENABLED: 'true',
  }).executionEnabled, false);
  assert.match(serverSource, /wa2InstanceReplacementConfig\(\)\.enabled/);
  assert.match(dbSource, /instance && wa2InstanceReplacementConfig\(\)\.enabled/);
  assert.match(scriptSource, /EXECUTION_FEATURE_DISABLED/);
  assert.match(scriptSource, /confirm-instance-replacement/);
  assert.match(scriptSource, /DRY_RUN_EXPIRED/);
  assert.match(scriptSource, /SAME_ACCOUNT_REPLACEMENT/);
  assert.match(scriptSource, /status=BLOCKED; writes=0/);
  assert.match(viewsSource, /Funcionalidade desativada/);
  assert.match(stackSource, /WA2_INSTANCE_REPLACEMENT_ENABLED: \$\{WA2_INSTANCE_REPLACEMENT_ENABLED:-false\}/);
  assert.match(stackSource, /WA2_INSTANCE_REPLACEMENT_EXECUTION_ENABLED: \$\{WA2_INSTANCE_REPLACEMENT_EXECUTION_ENABLED:-false\}/);
  assert.match(deployDocs, /Não use `DROP`,/);
});

test('normalização PN reconhece nono dígito brasileiro exatamente após o DDD', () => {
  assert.equal(normalizeCanonicalWhatsAppPhone(OLD_PHONE), CANONICAL_PHONE);
  assert.equal(normalizeCanonicalWhatsAppPhone(`${OLD_PHONE}@c.us`), CANONICAL_PHONE);
  assert.equal(normalizePnJid(`${OLD_PHONE}:12@s.whatsapp.net`), `${CANONICAL_PHONE}@s.whatsapp.net`);
  assert.equal(normalizePnJid(`${CANONICAL_PHONE}:47@s.whatsapp.net`), `${CANONICAL_PHONE}@s.whatsapp.net`);
});

test('telefone fixo não recebe nono dígito e identidade estrangeira não é aceita', () => {
  assert.equal(normalizeCanonicalWhatsAppPhone('553833330000', { confirmedMobile: false }), '553833330000');
  assert.equal(normalizePnJid('553833330000@s.whatsapp.net', { confirmedMobile: false }), '553833330000@s.whatsapp.net');
  assert.equal(normalizeCanonicalWhatsAppPhone('+14155552671'), null);
});

test('comparação exige telefone canônico e PN determinístico iguais', () => {
  const same = compareStableWhatsAppIdentity({
    canonicalPhone: CANONICAL_PHONE,
    normalizedPnJid: `${OLD_PHONE}@s.whatsapp.net`,
    phoneJid: `${CANONICAL_PHONE}@s.whatsapp.net`,
  });
  assert.equal(same.sameBrazilianMobileIdentity, true);
  const different = compareStableWhatsAppIdentity({
    canonicalPhone: CANONICAL_PHONE,
    normalizedPnJid: `${CANONICAL_PHONE}@s.whatsapp.net`,
    phoneJid: '5531999999999@s.whatsapp.net',
  });
  assert.equal(different.sameBrazilianMobileIdentity, false);
});

test('cutover temporal ignora evento anterior ou igual e libera somente evento posterior', () => {
  const cutover = '2026-08-06T12:00:00.000Z';
  assert.equal(isWa2ReplacementEventAfterCutover('2026-08-06T11:59:59.999Z', cutover), false);
  assert.equal(isWa2ReplacementEventAfterCutover(cutover, cutover), false);
  assert.equal(isWa2ReplacementEventAfterCutover('2026-08-06T12:00:00.001Z', cutover), true);
  assert.equal(isWa2ReplacementEventAfterCutover('invalid', cutover), false);
});

test('detecção aceita substituição somente com mesma conta, instância nova conectada e antiga inativa', () => {
  const result = detectWa2InstanceReplacement({
    tenantId: 'tenant-a',
    oldInstance: OLD_INSTANCE,
    newInstance: NEW_INSTANCE,
    oldStatus: OLD_STATUS,
    newStatus: NEW_STATUS,
    activeInstanceCount: 1,
  });
  assert.equal(result.classification, 'SAME_ACCOUNT_REPLACEMENT');
  assert.equal(result.newIdentity.normalizedPnJid, `${CANONICAL_PHONE}@s.whatsapp.net`);
});

test('detecção bloqueia múltiplas instâncias ativas, PN ausente e conta diferente', () => {
  assert.equal(detectWa2InstanceReplacement({
    tenantId: 'tenant-a', oldInstance: OLD_INSTANCE, newInstance: NEW_INSTANCE,
    oldStatus: OLD_STATUS, newStatus: NEW_STATUS, activeInstanceCount: 2,
  }).classification, 'MULTIPLE_ACTIVE_INSTANCES');
  assert.equal(detectWa2InstanceReplacement({
    tenantId: 'tenant-a', oldInstance: OLD_INSTANCE, newInstance: NEW_INSTANCE,
    oldStatus: OLD_STATUS, newStatus: { status: 'CONNECTED' }, activeInstanceCount: 1,
  }).classification, 'MISSING_AUTHENTICATED_PN');
  assert.equal(detectWa2InstanceReplacement({
    tenantId: 'tenant-a', oldInstance: OLD_INSTANCE, newInstance: NEW_INSTANCE,
    oldStatus: OLD_STATUS, newStatus: { status: 'CONNECTED', phone: '5531999999999' }, activeInstanceCount: 1,
  }).classification, 'NEW_WHATSAPP_ACCOUNT');
});

test('remapeamento exige nome exato e bloqueia etiqueta ausente ou ambígua', () => {
  const exact = planWa2LabelRemap(labelFixtures());
  assert.equal(exact.exactMatches.length, 6);
  assert.equal(exact.notFound.length, 0);
  assert.equal(exact.ambiguous.length, 0);
  const ambiguous = planWa2LabelRemap([...labelFixtures(), { id: 'duplicate', name: WA2_REPLACEMENT_LABEL_NAMES.CRM02 }]);
  assert.deepEqual(ambiguous.ambiguous, [{ code: 'CRM02', count: 2 }]);
  assert.deepEqual(planWa2LabelRemap(labelFixtures().slice(1)).notFound, ['CRM01']);
  assert.equal(planWa2LabelRemap(labelFixtures(), ['CRM01'], [{
    stage: 'CRM01', remote_label_id: 'label-CRM01', remote_label_name: WA2_REPLACEMENT_LABEL_NAMES.CRM01, enabled: true,
  }]).alreadyAligned.length, 1);
});

test('classificação de vínculo aceita somente match único por PN e bloqueia conflitos', () => {
  const oldLink = { lead_id: 'lead-1', phone_normalized: OLD_PHONE };
  const candidate = {
    leadId: 'lead-1',
    contactId: 'contact-1',
    chatId: 'chat-1',
    phoneNormalized: CANONICAL_PHONE,
    phoneJid: `${CANONICAL_PHONE}@s.whatsapp.net`,
    jid: `${CANONICAL_PHONE}@s.whatsapp.net`,
    identityPresent: true,
    identityCount: 1,
    newIdentityCount: 0,
    activeLinkCount: 1,
  };
  assert.equal(classifyWa2LinkCandidates({ leadId: 'lead-1', oldLink, candidates: [candidate] }).result, 'EXACT_SINGLE_MATCH');
  assert.equal(classifyWa2LinkCandidates({ leadId: 'lead-1', oldLink, candidates: [candidate, { ...candidate, chatId: 'chat-2' }] }).result, 'MULTIPLE_MATCHES');
  assert.equal(classifyWa2LinkCandidates({ leadId: 'lead-1', oldLink, candidates: [{ ...candidate, identityOwnerLeadId: 'lead-2' }] }).result, 'IDENTITY_CONFLICT');
  assert.equal(classifyWa2LinkCandidates({ leadId: 'lead-1', oldLink, candidates: [{ ...candidate, phoneJid: '5531999999999@s.whatsapp.net' }] }).result, 'PHONE_CONFLICT');
  assert.equal(classifyWa2LinkCandidates({ leadId: 'lead-1', oldLink: { ...oldLink, phone_normalized: 'not-a-phone' }, candidates: [candidate] }).result, 'INVALID_PHONE');
});

test('planner prevê apenas vínculo técnico e nunca etapa, MQL, job ou Graph', () => {
  const report = planWa2InstanceReplacement({
    tenantId: 'tenant-a', oldInstance: OLD_INSTANCE, newInstance: NEW_INSTANCE,
    oldStatus: OLD_STATUS, newStatus: NEW_STATUS, activeInstanceCount: 1,
    oldLinks: [{ lead_id: 'lead-1', phone_normalized: OLD_PHONE }],
    candidatesByLeadId: {
      'lead-1': [{
        leadId: 'lead-1', contactId: 'contact-1', chatId: 'chat-1',
        phoneNormalized: CANONICAL_PHONE, phoneJid: `${CANONICAL_PHONE}@s.whatsapp.net`,
        identityPresent: true, identityCount: 1, newIdentityCount: 0, activeLinkCount: 1,
      }],
    },
    newLabels: labelFixtures(),
    existingBindings: [],
  });
  assert.equal(report.writes.oldLinksToUnlink, 1);
  assert.equal(report.writes.newLinksToCreate, 1);
  assert.equal(report.writes.stagesChanged, 0);
  assert.equal(report.writes.mqlsCreated, 0);
  assert.equal(report.writes.conversionJobs, 0);
  assert.equal(report.writes.graphPosts, 0);
  assert.equal(report.writes.writesPerformed, 0);
});

test('dry-run web e CLI são separados da execução e preservam o primeiro vínculo existente', () => {
  assert.match(serverSource, /app\.get\('\/wa2\/instance-replacement'/);
  assert.match(serverSource, /app\.post\('\/wa2\/instance-replacement\/dry-run'/);
  assert.doesNotMatch(serverSource, /app\.post\('\/wa2\/instance-replacement\/execute'/);
  assert.match(viewsSource, /action="\/wa2\/instance-replacement\/dry-run"/);
  assert.match(viewsSource, /Nenhuma alteração é feita nesta tela/);
  assert.match(scriptSource, /hasFlag\('dry-run'\)/);
  assert.match(scriptSource, /hasFlag\('execute'\)/);
  assert.match(scriptSource, /WAITING_AUTHORIZATION/);
  assert.match(scriptSource, /RUN_BATCH_LIMIT_EXCEEDED/);
  assert.match(dbSource, /WA2_INSTANCE_REPLACED_REASON/);
  assert.match(dbSource, /recoveryReason/);
  assert.match(dbSource, /BEFORE_INSTANCE_REPLACEMENT_CUTOVER/);
  assert.match(runnerSource, /if \(!isNotFound\) throw error/);
});
