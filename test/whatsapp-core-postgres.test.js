import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/crm_meta_test';
const { pool } = await import('../src/db.js');
const core = await import('../src/whatsapp-core.js');

test('contatos, campanhas e envios usam as tabelas nativas migradas', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const prefix = `core-test-${process.pid}-${Date.now()}`;
  const instanceId = `${prefix}-instance`;
  const chatId = `${prefix}-chat`;
  const contactId = `${prefix}-contact`;
  const labelId = `${prefix}-label`;
  const sessionId = `${prefix}-session`;
  const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql', '023_whatsapp_core.sql');
  try {
    await pool.query(await fs.readFile(sqlPath, 'utf8'));
    await pool.query(
      `INSERT INTO "WhatsappInstance" ("id", "name", "role", "sessionKey", "updatedAt")
       VALUES ($1, 'Teste', 'GENERAL', $2, now())`,
      [instanceId, `${prefix}-session-key`],
    );
    await pool.query(
      `INSERT INTO "WhatsappSession" ("id", "instanceId", "updatedAt") VALUES ($1, $2, now())`,
      [sessionId, instanceId],
    );
    await pool.query(
      `INSERT INTO "WhatsappChat" ("id", "instanceId", "jid", "name", "updatedAt")
       VALUES ($1, $2, '5511999999999@s.whatsapp.net', 'Teste', now())`,
      [chatId, instanceId],
    );
    await pool.query(
      `INSERT INTO "WhatsappContact" ("id", "instanceId", "jid", "phone", "name", "updatedAt")
       VALUES ($1, $2, '5511999999999@s.whatsapp.net', '5511999999999', 'Teste', now())`,
      [contactId, instanceId],
    );
    await pool.query(
      `INSERT INTO "WhatsappLabel" ("id", "instanceId", "waLabelId", "name", "updatedAt")
       VALUES ($1, $2, $3, 'Teste', now())`,
      [labelId, instanceId, `${prefix}-remote-label`],
    );
    await pool.query(
      `INSERT INTO "WhatsappChatLabel" ("id", "instanceId", "chatId", "labelId", "jid", "updatedAt")
       VALUES ($1, $2, $3, $4, '5511999999999@s.whatsapp.net', now())`,
      [`${prefix}-chat-label`, instanceId, chatId, labelId],
    );

    const contacts = await core.listWhatsappContacts(instanceId, { search: 'Teste' });
    assert.equal(contacts.total, 1);
    assert.equal(contacts.contacts[0].labels[0].name, 'Teste');

    const created = await core.createWhatsappCampaign({
      instanceId,
      name: 'Teste de campanha',
      message: 'Olá {{nome}}',
      labelId,
    });
    assert.equal(created.recipientCount, 1);
    assert.equal((await core.listWhatsappCampaigns(instanceId))[0].recipientCount, 1);
    await core.updateWhatsappCampaign(instanceId, created.campaignId, 'start');
    await core.updateWhatsappCampaign(instanceId, created.campaignId, 'pause');
    await core.updateWhatsappCampaign(instanceId, created.campaignId, 'resume');
    await core.updateWhatsappCampaign(instanceId, created.campaignId, 'cancel');
    const sends = await core.listWhatsappSends(instanceId, created.campaignId);
    assert.equal(sends[0].status, 'canceled');
    assert.equal(sends[0].messageFinal, 'Olá Teste');
  } finally {
    await pool.query('DELETE FROM "Campaign" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappChatLabel" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappSession" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappContact" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappChat" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappLabel" WHERE "instanceId" = $1', [instanceId]);
    await pool.query('DELETE FROM "WhatsappInstance" WHERE "id" = $1', [instanceId]);
    await pool.end();
  }
});
