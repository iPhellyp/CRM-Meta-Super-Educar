import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWhatsAppPhone,
  normalizeWhatsAppPhoneOrNull,
} from '../src/phone.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(here, '..', 'sql', '003_wa2_contact_links.sql'),
  'utf8',
);
const dbSource = fs.readFileSync(path.join(here, '..', 'src', 'db.js'), 'utf8');

function plannedSqlBackfill(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (/^[1-9][0-9]{9,10}$/.test(digits)) return `55${digits}`;
  if (/^55[1-9][0-9]{9,10}$/.test(digits)) return digits;
  return null;
}

test('backfill planejado e normalizador JS são equivalentes por fixtures', () => {
  const fixtures = [
    '(38) 3333-0000',
    '(38) 99999-0000',
    '38999990000',
    '+55 38 99999-0000',
    '553833330000',
    '99999-0000',
    'texto',
    '',
    null,
  ];
  for (const fixture of fixtures) {
    assert.equal(plannedSqlBackfill(fixture), normalizeWhatsAppPhoneOrNull(fixture));
    assert.equal(plannedSqlBackfill(fixture) || '', normalizeWhatsAppPhone(fixture));
  }
});

test('migration 003 cria somente estruturas aditivas esperadas', () => {
  assert.match(migration, /ADD COLUMN phone_normalized TEXT/);
  assert.match(migration, /CREATE TABLE wa2_instances/);
  assert.match(migration, /CREATE TABLE wa2_contact_links/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
});

test('migration mantém índice de telefone não único e parcial', () => {
  assert.match(
    migration,
    /CREATE INDEX leads_tenant_phone_normalized_idx[\s\S]*ON leads \(tenant_id, phone_normalized\)[\s\S]*WHERE phone_normalized IS NOT NULL/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE UNIQUE INDEX\s+\S+\s+ON leads \(tenant_id, phone_normalized\)/,
  );
  assert.doesNotMatch(migration, /UNIQUE \(tenant_id, phone_normalized\)/);
});

test('migration impõe isolamento por tenant com FKs compostas', () => {
  assert.match(migration, /UNIQUE \(tenant_id, id\)/);
  assert.match(
    migration,
    /FOREIGN KEY \(tenant_id, lead_id\)[\s\S]*REFERENCES leads \(tenant_id, id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(tenant_id, wa2_instance_id\)[\s\S]*REFERENCES wa2_instances \(tenant_id, id\)/,
  );
  assert.match(migration, /UNIQUE \(remote_instance_id\)/);
});

test('migration permite somente um vínculo ativo por lead e por chat na instância', () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX wa2_contact_links_active_chat_uidx[\s\S]*WHERE unlinked_at IS NULL/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX wa2_contact_links_active_lead_uidx[\s\S]*WHERE unlinked_at IS NULL/,
  );
});

test('migration preserva histórico por desvínculo lógico', () => {
  for (const column of ['unlinked_at', 'unlinked_by', 'unlink_reason']) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  assert.match(
    migration,
    /wa2_contact_links_lead_fk[\s\S]*?REFERENCES leads \(tenant_id, id\)[\s\S]*?ON DELETE (?:RESTRICT|NO ACTION)/,
  );
});

test('migration restringe JID a contatos individuais suportados', () => {
  assert.ok(
    migration.includes("CHECK (jid ~ '^[0-9]+@(s\\.whatsapp\\.net|c\\.us)$')"),
  );
  const individualJid = /^[0-9]+@(s\.whatsapp\.net|c\.us)$/;
  assert.equal(individualJid.test('5538999990000@s.whatsapp.net'), true);
  assert.equal(individualJid.test('5538999990000@c.us'), true);
  for (const jid of [
    '5538999990000@lid',
    '120363000000000000@g.us',
    'status@broadcast',
    'newsletter@newsletter',
  ]) {
    assert.equal(individualJid.test(jid), false);
  }
});

test('queries de vínculo mantêm tenant e não alteram funil ou dados Meta', () => {
  const start = dbSource.indexOf('export async function getActiveWa2ContactLinkForLead');
  const end = dbSource.indexOf('async function createOrGetMetaEvent');
  const rebindStart = dbSource.indexOf('export async function rebindVerifiedWa2IdentityToChat', start);
  const cleanCanaryStart = dbSource.indexOf('export async function getMetaCleanCanarySnapshot', start);
  const identityStart = dbSource.indexOf('export async function createVerifiedWhatsAppIdentityAndLink', cleanCanaryStart);
  const linkQueries = dbSource.slice(start, cleanCanaryStart > start ? cleanCanaryStart : end);
  const identityQueries = dbSource.slice(identityStart, rebindStart > identityStart ? rebindStart : end);
  const querySource = `${linkQueries}\n${identityQueries}`;
  assert.ok(start >= 0 && end > start);
  assert.match(querySource, /tenant_id/g);
  assert.match(identityQueries, /FOR UPDATE/);
  assert.match(querySource, /unlinked_at = now\(\)/);
  assert.doesNotMatch(querySource, /UPDATE leads SET stage/);
  assert.doesNotMatch(querySource, /meta_conversion_events/);
  assert.doesNotMatch(querySource, /\bDELETE\s+FROM\b/);
});
