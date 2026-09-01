import crypto from 'node:crypto';
import { pool } from './db.js';

const MAX_RECIPIENTS = 500;

function boundedSearch(value) {
  return String(value || '').trim().slice(0, 120);
}

function boundedLimit(value, fallback = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), MAX_RECIPIENTS) : fallback;
}

function renderWhatsappMessage(template, recipient) {
  const phone = String(recipient.phone || recipient.jid || '').split('@')[0];
  return String(template)
    .replaceAll('{{nome}}', recipient.displayName || phone || 'contato')
    .replaceAll('{{telefone}}', phone)
    .replaceAll('{{origem}}', 'WhatsApp');
}

export async function listWhatsappContacts(instanceId, { search = '', limit = 100, offset = 0 } = {}) {
  const safeSearch = boundedSearch(search);
  const safeLimit = boundedLimit(limit);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const values = [instanceId];
  const filters = ['contact."instanceId" = $1'];
  if (safeSearch) {
    values.push(`%${safeSearch}%`);
    filters.push(`(
      contact."name" ILIKE $${values.length}
      OR contact."pushName" ILIKE $${values.length}
      OR contact."phone" ILIKE $${values.length}
      OR contact."jid" ILIKE $${values.length}
    )`);
  }
  values.push(safeLimit, safeOffset);
  const page = await pool.query(
    `SELECT contact."id", contact."jid", contact."phone", contact."name", contact."pushName",
            contact."isBusiness", contact."updatedAt", chat."id" AS "chatId",
            chat."lastMessageAt", chat."lastMessageText",
            COALESCE(labels.labels, '[]'::jsonb) AS labels
       FROM "WhatsappContact" contact
       LEFT JOIN "WhatsappChat" chat
         ON chat."instanceId" = contact."instanceId" AND chat."jid" = contact."jid"
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('id', label."id", 'name', label."name", 'color', label."color")
                          ORDER BY label."name") AS labels
           FROM "WhatsappChatLabel" chat_label
           JOIN "WhatsappLabel" label ON label."id" = chat_label."labelId"
          WHERE chat_label."instanceId" = contact."instanceId"
            AND chat_label."chatId" = chat."id"
            AND label."deleted" = false
       ) labels ON true
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(NULLIF(contact."name", ''), NULLIF(contact."pushName", ''), contact."phone", contact."jid") ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const count = await pool.query(
    `SELECT count(*)::int AS total FROM "WhatsappContact" contact WHERE ${filters.join(' AND ')}`,
    values.slice(0, -2),
  );
  return { contacts: page.rows, total: count.rows[0]?.total || 0 };
}

export async function listWhatsappLabels(instanceId) {
  const result = await pool.query(
    `SELECT "id", "waLabelId", "name", "color"
       FROM "WhatsappLabel"
      WHERE "instanceId" = $1 AND "deleted" = false
      ORDER BY "name" ASC`,
    [instanceId],
  );
  return result.rows;
}

export async function listWhatsappCampaigns(instanceId) {
  const result = await pool.query(
    `SELECT campaign."id", campaign."name", campaign."defaultMessage", campaign."status",
            campaign."targetMode", campaign."targetLabelId", campaign."intervalMinutes",
            campaign."createdAt", campaign."scheduledAt", campaign."startedAt",
            campaign."completedAt", campaign."lastError", label."name" AS "targetLabelName",
            count(recipient."id")::int AS "recipientCount",
            count(recipient."id") FILTER (WHERE recipient."status" = 'sent')::int AS sent,
            count(recipient."id") FILTER (WHERE recipient."status" = 'failed')::int AS failed,
            count(recipient."id") FILTER (WHERE recipient."status" IN ('pending', 'scheduled', 'sending'))::int AS pending,
            count(recipient."id") FILTER (WHERE recipient."status" = 'canceled')::int AS canceled
       FROM "Campaign" campaign
       LEFT JOIN "CampaignRecipient" recipient
         ON recipient."campaignId" = campaign."id" AND recipient."instanceId" = campaign."instanceId"
       LEFT JOIN "WhatsappLabel" label ON label."id" = campaign."targetLabelId"
      WHERE campaign."instanceId" = $1
      GROUP BY campaign."id", label."name"
      ORDER BY campaign."createdAt" DESC`,
    [instanceId],
  );
  return result.rows;
}

export async function listWhatsappSends(instanceId, campaignId = '') {
  const values = [instanceId];
  const filters = ['recipient."instanceId" = $1'];
  if (campaignId) {
    values.push(campaignId);
    filters.push(`recipient."campaignId" = $${values.length}`);
  }
  const result = await pool.query(
    `SELECT recipient."id", recipient."campaignId", campaign."name" AS "campaignName",
            recipient."jid", recipient."messageFinal", recipient."status",
            recipient."skippedReason", recipient."attemptCount", recipient."scheduledAt",
            recipient."sentAt", recipient."error", recipient."updatedAt",
            COALESCE(NULLIF(contact."name", ''), NULLIF(wa_contact."name", ''), chat."name", recipient."jid") AS "displayName"
       FROM "CampaignRecipient" recipient
       JOIN "Campaign" campaign ON campaign."id" = recipient."campaignId"
       LEFT JOIN "Contact" contact ON contact."id" = recipient."contactId"
       LEFT JOIN "WhatsappContact" wa_contact
         ON wa_contact."instanceId" = recipient."instanceId" AND wa_contact."jid" = recipient."jid"
       LEFT JOIN "WhatsappChat" chat
         ON chat."id" = recipient."chatId" AND chat."instanceId" = recipient."instanceId"
      WHERE ${filters.join(' AND ')}
      ORDER BY recipient."updatedAt" DESC
      LIMIT 500`,
    values,
  );
  return result.rows;
}

async function selectCampaignRecipients(client, instanceId, { labelId = '', contactIds = [] } = {}) {
  if (labelId) {
    const result = await client.query(
      `SELECT DISTINCT chat."id" AS "chatId", chat."jid",
              wa_contact."phone", COALESCE(NULLIF(wa_contact."name", ''), NULLIF(wa_contact."pushName", ''), chat."name") AS "displayName"
         FROM "WhatsappChatLabel" chat_label
         JOIN "WhatsappChat" chat ON chat."id" = chat_label."chatId"
         LEFT JOIN "WhatsappContact" wa_contact
           ON wa_contact."instanceId" = chat."instanceId" AND wa_contact."jid" = chat."jid"
        WHERE chat_label."instanceId" = $1
          AND chat_label."labelId" = $2
          AND chat."instanceId" = $1
          AND chat."isGroup" = false
          AND chat."jid" ~ '^[0-9]+@(s\\.whatsapp\\.net|c\\.us)$'
        ORDER BY chat."jid"
        LIMIT ${MAX_RECIPIENTS}`,
      [instanceId, labelId],
    );
    return result.rows;
  }

  const ids = Array.from(new Set(contactIds.map((id) => String(id).trim()).filter(Boolean)))
    .slice(0, MAX_RECIPIENTS);
  if (!ids.length) return [];
  const result = await client.query(
    `SELECT DISTINCT chat."id" AS "chatId", chat."jid",
            wa_contact."phone", COALESCE(NULLIF(wa_contact."name", ''), NULLIF(wa_contact."pushName", ''), chat."name") AS "displayName"
       FROM "WhatsappContact" wa_contact
       JOIN "WhatsappChat" chat
         ON chat."instanceId" = wa_contact."instanceId" AND chat."jid" = wa_contact."jid"
      WHERE wa_contact."instanceId" = $1
        AND wa_contact."id" = ANY($2::text[])
        AND chat."isGroup" = false
        AND chat."jid" ~ '^[0-9]+@(s\\.whatsapp\\.net|c\\.us)$'
      ORDER BY chat."jid"
      LIMIT ${MAX_RECIPIENTS}`,
    [instanceId, ids],
  );
  return result.rows;
}

export async function createWhatsappCampaign({
  instanceId,
  name,
  message,
  labelId = '',
  contactIds = [],
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const label = labelId
      ? await client.query(
        `SELECT "id" FROM "WhatsappLabel"
          WHERE "id" = $1 AND "instanceId" = $2 AND "deleted" = false`,
        [labelId, instanceId],
      )
      : { rowCount: 0 };
    if (labelId && !label.rowCount) {
      const error = new Error('Etiqueta WhatsApp não encontrada');
      error.code = 'WHATSAPP_LABEL_NOT_FOUND';
      throw error;
    }

    const recipients = await selectCampaignRecipients(client, instanceId, { labelId, contactIds });
    if (!recipients.length) {
      const error = new Error('Nenhum contato individual elegível foi encontrado');
      error.code = 'WHATSAPP_CAMPAIGN_EMPTY';
      throw error;
    }

    const campaignId = crypto.randomUUID();
    const now = new Date();
    await client.query(
      `INSERT INTO "Campaign" (
        "id", "instanceId", "name", "defaultMessage", "intervalMinutes", "status",
        "targetMode", "targetLabelId", "excludeGroups", "dedupeMode", "creationKey",
        "maxRecipients", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, 1, 'draft', $5, $6, true, 'same_campaign', $7, $8, $9, $9)`,
      [
        campaignId,
        instanceId,
        name,
        message,
        labelId ? 'label' : 'chatIds',
        labelId || null,
        `crm-${campaignId}`,
        recipients.length,
        now,
      ],
    );

    for (const recipient of recipients) {
      const recipientId = crypto.randomUUID();
      await client.query(
        `INSERT INTO "CampaignRecipient" (
          "id", "instanceId", "campaignId", "chatId", "jid", "messageFinal",
          "status", "dedupeKey", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $8)`,
        [recipientId, instanceId, campaignId, recipient.chatId, recipient.jid, renderWhatsappMessage(message, recipient), `${campaignId}:${recipient.jid}`, now],
      );
    }
    await client.query('COMMIT');
    return { campaignId, recipientCount: recipients.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWhatsappCampaign(instanceId, campaignId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crm-whatsapp-campaign:${instanceId}`]);
    if (action === 'start' || action === 'resume') {
      const allowed = action === 'resume' ? ['paused'] : ['draft', 'scheduled'];
      const running = await client.query(
        `SELECT 1 FROM "Campaign" WHERE "instanceId" = $1 AND "status" = 'running' LIMIT 1`,
        [instanceId],
      );
      if (running.rowCount) {
        const error = new Error('Já existe uma campanha ativa nesta instância');
        error.code = 'WHATSAPP_CAMPAIGN_ALREADY_RUNNING';
        throw error;
      }
      const result = await client.query(
        `UPDATE "Campaign"
            SET "status" = 'running', "scheduledAt" = NULL,
                "startedAt" = COALESCE("startedAt", now()), "lastError" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "instanceId" = $2 AND "status" = ANY($3::"CampaignStatus"[])
        RETURNING "id"`,
        [campaignId, instanceId, allowed],
      );
      if (!result.rowCount) {
        const error = new Error('Campanha não pode ser iniciada neste status');
        error.code = 'WHATSAPP_CAMPAIGN_NOT_STARTABLE';
        throw error;
      }
    } else if (action === 'pause') {
      const result = await client.query(
        `UPDATE "Campaign" SET "status" = 'paused', "updatedAt" = now()
          WHERE "id" = $1 AND "instanceId" = $2 AND "status" = 'running'
        RETURNING "id"`,
        [campaignId, instanceId],
      );
      if (!result.rowCount) {
        const error = new Error('Campanha não está em execução');
        error.code = 'WHATSAPP_CAMPAIGN_NOT_RUNNING';
        throw error;
      }
    } else if (action === 'cancel') {
      const campaign = await client.query(
        `UPDATE "Campaign" SET "status" = 'canceled', "nextDispatchAt" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "instanceId" = $2
            AND "status" IN ('draft', 'scheduled', 'running', 'paused')
        RETURNING "id"`,
        [campaignId, instanceId],
      );
      if (!campaign.rowCount) {
        const error = new Error('Campanha não encontrada ou já finalizada');
        error.code = 'WHATSAPP_CAMPAIGN_NOT_CANCELABLE';
        throw error;
      }
      await client.query(
        `UPDATE "CampaignRecipient"
            SET "status" = 'canceled', "error" = 'Campanha cancelada', "updatedAt" = now()
          WHERE "instanceId" = $1 AND "campaignId" = $2
            AND "status" IN ('pending', 'scheduled', 'sending')`,
        [instanceId, campaignId],
      );
    } else {
      const error = new Error('Ação de campanha inválida');
      error.code = 'WHATSAPP_CAMPAIGN_ACTION_INVALID';
      throw error;
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
