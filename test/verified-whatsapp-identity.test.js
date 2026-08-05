import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
const migration = read('sql/013_verified_whatsapp_identities.sql');
const phoneJidMigration = read('sql/014_fix_verified_whatsapp_phone_jid_check.sql');
const contactEvidenceMigration = read('sql/017_verified_identity_contact_evidence.sql');
const db = read('src/db.js');
const server = read('src/server.js');
const views = read('src/views.js');

test('identidade verificada tem migração aditiva, tenant e unicidade', () => {
  assert.doesNotMatch(migration, /^\s*(DELETE|TRUNCATE|UPDATE)\b/im);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  assert.match(migration, /CREATE TABLE lead_verified_whatsapp_identities/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, lead_id\)[\s\S]*REFERENCES leads \(tenant_id, id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, wa2_instance_id\)[\s\S]*REFERENCES wa2_instances \(tenant_id, id\)/);
  assert.match(migration, /CREATE UNIQUE INDEX lead_verified_whatsapp_identities_lead_uidx/);
  assert.match(migration, /CREATE UNIQUE INDEX lead_verified_whatsapp_identities_phone_uidx/);
  assert.match(migration, /canonical_phone/);
  assert.match(migration, /aliases JSONB/);
  assert.match(migration, /evidence_wa_message_id/);
});

test('constraint do PN aceita os domínios WA2 reais sem aceitar JID arbitrário', () => {
  assert.match(phoneJidMigration, /phone_jid/);
  assert.match(phoneJidMigration, /s\[\.\]whatsapp\[\.\]net/);
  assert.match(phoneJidMigration, /c\[\.\]us/);
  assert.doesNotMatch(phoneJidMigration, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test('evidência de contato atual é tipada, idempotente e não inventa mensagem', () => {
  assert.match(contactEvidenceMigration, /evidence_type TEXT NOT NULL DEFAULT 'WA2_MESSAGE'/);
  assert.match(contactEvidenceMigration, /evidence_reference TEXT/);
  assert.match(contactEvidenceMigration, /WA2_CONTACT_STATE/);
  assert.match(contactEvidenceMigration, /evidence_wa_message_id DROP NOT NULL/);
  assert.match(contactEvidenceMigration, /evidence_pair_check/);
  assert.doesNotMatch(contactEvidenceMigration, /DELETE FROM|TRUNCATE|DROP TABLE/i);
});

test('ação de identidade preserva lead, exige INTERNAL_TEST e é transacional/idempotente', () => {
  const start = db.indexOf('export async function createVerifiedWhatsAppIdentityAndLink');
  const end = db.indexOf('async function lockWa2LinkParents', start);
  const source = db.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /is_internal_test/);
  assert.match(source, /meta_outbound_eligible !== false/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /existingIdentity/);
  assert.match(source, /evidence\?\.lidJid/);
  assert.match(source, /sourcePhoneNormalized/);
  assert.match(source, /O LID da evidência não corresponde/);
  assert.match(source, /idempotent: true/);
  assert.match(source, /activeConflict/);
  assert.match(source, /UPDATE leads[\s\S]*whatsapp_normalized/);
  assert.doesNotMatch(source, /UPDATE leads[\s\S]*\bphone\s*=/);
  assert.doesNotMatch(source, /UPDATE leads[\s\S]*\bstage\s*=/);
  assert.doesNotMatch(source, /WA2_VERIFIED_IDENTITY_NOT_ALTERNATE/);
  assert.doesNotMatch(source, /meta_conversion_events/);
  assert.match(source, /WHATSAPP_IDENTITY_VERIFIED/);
});

test('identidade determinística de vínculo normal é segura e não altera etapa', () => {
  const start = db.indexOf('export async function verifyExistingWa2Identity');
  const end = db.indexOf('async function lockWa2LinkParents', start);
  const source = db.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /WA2_CONTACT_STATE/);
  assert.match(source, /WA2_IDENTITY_LID_WITHOUT_PN/);
  assert.match(source, /WA2_IDENTITY_USED_BY_ANOTHER_LEAD/);
  assert.match(source, /NO_ACTIVE_LINK/);
  assert.match(source, /ALREADY_VERIFIED/);
  assert.match(source, /evidenceReference/);
  assert.match(source, /WHATSAPP_IDENTITY_VERIFIED/);
  assert.doesNotMatch(source, /UPDATE leads SET stage/);
  assert.doesNotMatch(source, /meta_conversion_events/);
});

test('rota de identidade exige autenticação/CSRF global e evidência exata', () => {
  const auth = server.indexOf('app.use(requireAuth)');
  const csrf = server.indexOf("req.method === 'POST' ? requireCsrf");
  const route = server.indexOf("/leads/:id/wa2/verify-identity");
  assert.ok(auth >= 0 && csrf > auth && route > csrf);
  const routeSource = server.slice(route, server.indexOf("app.post('/leads/:id/wa2/verify'", route));
  assert.match(routeSource, /VERIFY_MOBILE_ALIAS/);
  assert.match(routeSource, /waMessageId/);
  assert.match(routeSource, /lidJid/);
  assert.match(routeSource, /getWa2ContactByPhone/);
  assert.match(views, /Registrar identidade e criar vínculo WA2/);
});
