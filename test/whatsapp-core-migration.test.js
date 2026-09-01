import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(here, '..', 'sql', '023_whatsapp_core.sql'),
  'utf8',
);

test('migration do núcleo WhatsApp é aditiva e idempotente no schema', () => {
  assert.doesNotMatch(migration, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  for (const table of [
    'WhatsappInstance', 'WhatsappSession', 'Contact', 'WhatsappChat',
    'WhatsappContact', 'WhatsappMessage', 'WhatsappLabel', 'WhatsappChatLabel',
    'WhatsappLabelEvent', 'WhatsappIdentity', 'CrmLabelEventDelivery', 'ImportBatch',
    'Campaign', 'CampaignRecipient', 'SendLog',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
  }
  assert.match(migration, /CREATE TYPE "WhatsappStatus" AS ENUM/);
  assert.match(migration, /duplicate_object/);
  assert.match(migration, /WhatsappMessage_chatId_fkey/);
  assert.match(migration, /CampaignRecipient_campaignId_fkey/);
});

test('copiador do núcleo WhatsApp exige modo explícito e é idempotente', () => {
  const copier = fs.readFileSync(
    path.join(here, '..', 'scripts', 'migrate-wa2-data.mjs'),
    'utf8',
  );
  assert.match(copier, /--dry-run/);
  assert.match(copier, /--execute/);
  assert.match(copier, /WA2_DATABASE_URL/);
  assert.match(copier, /ON CONFLICT DO NOTHING/);
  assert.match(copier, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(copier, /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/);
});
