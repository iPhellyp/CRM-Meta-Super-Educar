import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WA2_CHAT_REBIND_ACTIVITY,
  WA2_CHAT_REBIND_REASON,
  createRebindHistoryMetadata,
  rebindPayloadHash,
  sameAliasSet,
  validateRebindAdapterEvidence,
} from '../src/wa2-rebind.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
const db = read('src/db.js');
const migration = read('sql/015_wa2_chat_rebind.sql');
const dockerfile = read('Dockerfile');

const evidence = {
  adapterValidated: true,
  instanceId: 'wa-instance',
  chatId: 'chat-new',
  contactId: 'contact-new',
  waMessageId: 'wa-message-1',
  fromMe: false,
  observedAt: '2026-08-04T18:03:24.000Z',
  lidJid: 'lid-1@lid',
  phoneJid: '5538988515846@s.whatsapp.net',
};

test('rebind compara identidade e evidência sem aceitar outbound ou divergência', () => {
  assert.equal(validateRebindAdapterEvidence(evidence, evidence), true);
  assert.throws(
    () => validateRebindAdapterEvidence({ ...evidence, fromMe: true }, evidence),
  );
  assert.throws(
    () => validateRebindAdapterEvidence(evidence, { ...evidence, chatId: 'chat-other' }),
  );
});

test('rebind preserva aliases como conjunto e deriva idempotência determinística', () => {
  assert.equal(sameAliasSet(['5538988515846', '553888515846'], ['553888515846', '5538988515846']), true);
  assert.equal(sameAliasSet(['5538988515846'], ['553888515846']), false);
  const base = {
    leadId: 'lead',
    instanceId: 'instance',
    expectedActiveLinkId: 'old-link',
    expectedOldRemoteChatId: 'chat-old',
    newRemoteChatId: 'chat-new',
    newRemoteContactId: 'contact-new',
    newRemoteJid: evidence.phoneJid,
    canonicalPhone: '5538988515846',
    pn: evidence.phoneJid,
    lid: evidence.lidJid,
    evidenceWaMessageId: evidence.waMessageId,
    evidenceTimestamp: evidence.observedAt,
    reason: WA2_CHAT_REBIND_REASON,
    idempotencyKey: 'wa2-rebind:key',
  };
  assert.equal(rebindPayloadHash(base), rebindPayloadHash({ ...base }), true);
  assert.notEqual(rebindPayloadHash(base), rebindPayloadHash({ ...base, newRemoteChatId: 'chat-other' }));
});

test('histórico do rebind guarda somente hashes de identificadores remotos', () => {
  const metadata = createRebindHistoryMetadata({
    identityId: 'identity',
    oldLinkId: 'old-link',
    newLinkId: 'new-link',
    instanceId: 'instance',
    oldRemoteChatId: 'chat-old',
    newRemoteChatId: 'chat-new',
    remoteContactId: 'contact-new',
    pn: evidence.phoneJid,
    lid: evidence.lidJid,
    evidenceWaMessageId: evidence.waMessageId,
    evidenceTimestamp: evidence.observedAt,
    reason: WA2_CHAT_REBIND_REASON,
    actor: 'system',
    idempotencyKey: 'wa2-rebind:key',
    payloadHash: 'payload-hash',
  });
  assert.equal(metadata.event, WA2_CHAT_REBIND_ACTIVITY);
  assert.equal(metadata.reason, WA2_CHAT_REBIND_REASON);
  assert.equal(metadata.previousRemoteChatHash.length, 64);
  assert.equal(metadata.newRemoteChatHash.length, 64);
  assert.equal(JSON.stringify(metadata).includes('chat-old'), false);
  assert.equal(JSON.stringify(metadata).includes(evidence.phoneJid), false);
});

test('migration do rebind é aditiva e protege idempotência', () => {
  assert.doesNotMatch(migration, /\b(DROP TABLE|DELETE FROM|TRUNCATE)\b/i);
  assert.match(migration, /WA2_CHAT_REBOUND/);
  assert.match(migration, /lead_stage_history_wa2_rebind_idempotency_uidx/);
  assert.match(migration, /metadata->>'idempotencyKey'/);
});

test('action transacional não altera etapa nem cria Meta', () => {
  const start = db.indexOf('export async function rebindVerifiedWa2IdentityToChat');
  const end = db.indexOf('async function createOrGetMetaEvent', start);
  const source = db.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /BEGIN/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /WA2_CHAT_REBIND_ACTIVITY/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /UPDATE wa2_contact_links/);
  assert.match(source, /AND id <> \$5/);
  assert.match(source, /UPDATE lead_verified_whatsapp_identities/);
  assert.doesNotMatch(source, /UPDATE leads SET stage/);
  assert.doesNotMatch(source, /INSERT INTO meta_conversion_events/);
  assert.doesNotMatch(source, /INSERT INTO meta_jobs/);
});

test('script operacional isolado entra na imagem sem copiar segredos', () => {
  assert.match(dockerfile, /scripts\/rebind-wa2-chat-b1\.mjs/);
  assert.doesNotMatch(dockerfile, /\.env|secret|token/i);
});
