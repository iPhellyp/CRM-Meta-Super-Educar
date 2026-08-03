import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  canTransition,
  getStageEventName,
  isLossStage,
  isProtectedCommercialStage,
  isValidHistoryOrigin,
  originMayConfirmProtectedStage,
} from './funnel.js';
import {
  normalizeWhatsAppPhoneOrNull,
} from './phone.js';
import {
  Wa2LinkRuleError as Wa2DataError,
  assertNoActiveWa2LinkConflict,
  validateWa2LinkParents,
} from './wa2-link-rules.js';
import {
  isWa2LabelStage,
  stagesSharingWa2Label,
} from './wa2-label-sync.js';
import {
  canCreateMetaForStage,
  classifyWa2LinkResolution,
  decideInboundLabelAction,
} from './historical-sync.js';

const { Pool } = pg;
const DEFAULT_TENANT_ID = 'super-educar';
const WORKER_NAME = 'meta-worker';
export const WA2_EXTERNAL_LABEL_FILTER = '__external__';
export const WA2_NO_EXTERNAL_LABEL_FILTER = '__none__';
export const WA2_ANY_LABEL_FILTER = WA2_EXTERNAL_LABEL_FILTER;
export const WA2_NO_LABEL_FILTER = WA2_NO_EXTERNAL_LABEL_FILTER;
export const WA2_ANY_COMPLEMENTARY_LABEL_FILTER = '__complementary__';
export const WA2_NO_COMPLEMENTARY_LABEL_FILTER = '__none_complementary__';

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

export function parseWa2LabelKey(value) {
  const raw = String(value || '').trim();
  const match = raw.match(new RegExp(`^(${UUID_PATTERN}):([A-Za-z0-9_-]{1,128})$`));
  return match ? { instanceId: match[1], remoteLabelId: match[2] } : null;
}

function currentWa2LabelsCte() {
  return `WITH current_wa2_labels AS (
    SELECT DISTINCT ON (
      receipt.tenant_id, link.wa2_instance_id, receipt.remote_chat_id, receipt.remote_label_id
    )
      receipt.tenant_id,
      link.lead_id,
      link.wa2_instance_id,
      instance.name AS instance_name,
      instance.remote_instance_id,
      receipt.remote_chat_id,
      receipt.remote_label_id,
      receipt.operation,
      COALESCE(receipt.remote_label_name, binding.remote_label_name, receipt.remote_label_id) AS remote_label_name,
      (binding.id IS NOT NULL AND binding.enabled = true) AS official,
      receipt.observed_at,
      receipt.received_at
    FROM wa2_contact_links link
    JOIN wa2_instances instance
      ON instance.tenant_id = link.tenant_id AND instance.id = link.wa2_instance_id
    JOIN wa2_label_event_receipts receipt
      ON receipt.tenant_id = link.tenant_id
     AND receipt.remote_instance_id = instance.remote_instance_id
     AND receipt.remote_chat_id = link.remote_chat_id
    LEFT JOIN wa2_label_bindings binding
      ON binding.tenant_id = link.tenant_id
     AND binding.wa2_instance_id = link.wa2_instance_id
     AND binding.remote_label_id = receipt.remote_label_id
    WHERE link.tenant_id = $1 AND link.unlinked_at IS NULL
      AND instance.enabled = true
    ORDER BY
      receipt.tenant_id, link.wa2_instance_id, receipt.remote_chat_id,
      receipt.remote_label_id, receipt.observed_at DESC, receipt.received_at DESC,
      receipt.id DESC
  )`;
}

function currentWa2LabelExists({ alias = 'current_wa2_labels', leadColumn = 'leads.id', instanceId, remoteLabelId, complementary } = {}) {
  const conditions = [`${alias}.tenant_id = leads.tenant_id`, `${alias}.lead_id = ${leadColumn}`, `${alias}.operation = 'APPLY'`];
  if (instanceId) conditions.push(`${alias}.wa2_instance_id = $${instanceId}`);
  if (remoteLabelId) conditions.push(`${alias}.remote_label_id = $${remoteLabelId}`);
  if (complementary === true) conditions.push(`${alias}.official = false`);
  if (complementary === false) conditions.push(`${alias}.official = true`);
  return `EXISTS (SELECT 1 FROM ${alias} WHERE ${conditions.join(' AND ')})`;
}

export { Wa2LinkRuleError as Wa2DataError } from './wa2-link-rules.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

function tenantId() {
  return process.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
}

export function validateDatabaseConfig() {
  const errors = [];
  if (!String(process.env.DATABASE_URL || '').trim()) errors.push('DATABASE_URL');
  if (!['true', 'false'].includes(process.env.DATABASE_SSL || '')) {
    errors.push('DATABASE_SSL=true ou false');
  }
  if (!String(process.env.DEFAULT_TENANT_ID || '').trim()) errors.push('DEFAULT_TENANT_ID');
  if (errors.length) throw new Error(`Configuração do banco inválida: ${errors.join(', ')}`);
}

export function operationStartAt() {
  const value = process.env.OPERATION_START_AT;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function migrate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sqlDirectory = path.join(here, '..', 'sql');
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('crm_meta_migrate'))");
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const migrationFiles = (await fs.readdir(sqlDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    const appliedResult = await client.query('SELECT filename FROM schema_migrations');
    const appliedMigrations = new Set(appliedResult.rows.map((row) => row.filename));

    for (const migrationFile of migrationFiles) {
      if (appliedMigrations.has(migrationFile)) continue;
      const sql = await fs.readFile(path.join(sqlDirectory, migrationFile), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [migrationFile],
        );
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original migration error.
        }
        throw error;
      }
    }
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock(hashtext('crm_meta_migrate'))");
      }
    } finally {
      client.release();
    }
  }
}

export async function healthcheck() {
  const result = await pool.query('SELECT now() AS now');
  return result.rows[0];
}

export async function listLeads({
  stage,
  commercial,
  search,
  course,
  city,
  lostReason,
  instanceId,
  labelId,
  metaConnectionId,
  businessId,
  pageId,
  formId,
  campaignId,
  adsetId,
  adId,
  attributed,
  validPhone,
  unattended,
  createdAfter = operationStartAt(),
  createdBefore,
  sort = 'recent',
  limit = 100,
  offset = 0,
} = {}) {
  const values = [tenantId()];
  const currentMetaMode = process.env.META_TEST_MODE === 'true' ? 'test' : 'live';
  const where = ['leads.tenant_id = $1'];

  if (stage) {
    values.push(stage);
    where.push(`leads.stage = $${values.length}`);
  }
  if (commercial === 'mql') {
    where.push(`leads.stage IN ('QUALIFIED', 'NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT')`);
  }

  if (search) {
    values.push(`%${search}%`);
    where.push(`(
      leads.name ILIKE $${values.length}
      OR leads.phone ILIKE $${values.length}
      OR leads.email ILIKE $${values.length}
      OR leads.course ILIKE $${values.length}
      OR leads.city ILIKE $${values.length}
      OR leads.phone_normalized ILIKE $${values.length}
    )`);
  }
  for (const [value, column] of [
    [course, 'leads.course'],
    [city, 'leads.city'],
    [lostReason, 'leads.lost_reason'],
    [metaConnectionId, 'leads.meta_connection_id'],
    [businessId, 'connection.business_id'],
    [pageId, 'leads.meta_page_id'],
    [formId, 'leads.meta_form_id'],
    [campaignId, 'leads.meta_campaign_id'],
    [adsetId, 'leads.meta_adset_id'],
    [adId, 'leads.meta_ad_id'],
  ]) {
    if (value) {
      values.push(value);
      where.push(`${column} = $${values.length}`);
    }
  }
  if (instanceId) {
    values.push(instanceId);
    where.push(`EXISTS (
      SELECT 1 FROM wa2_contact_links link
      WHERE link.tenant_id = leads.tenant_id
        AND link.lead_id = leads.id
        AND link.wa2_instance_id = $${values.length}
        AND link.unlinked_at IS NULL
    )`);
  }
  if (labelId) {
    if ([
      WA2_ANY_LABEL_FILTER,
      WA2_NO_LABEL_FILTER,
      WA2_ANY_COMPLEMENTARY_LABEL_FILTER,
      WA2_NO_COMPLEMENTARY_LABEL_FILTER,
    ].includes(labelId)) {
      const complementary = [
        WA2_ANY_COMPLEMENTARY_LABEL_FILTER,
        WA2_NO_COMPLEMENTARY_LABEL_FILTER,
      ].includes(labelId);
      const exists = currentWa2LabelExists({ complementary: complementary ? true : undefined });
      where.push(labelId === WA2_NO_LABEL_FILTER || labelId === WA2_NO_COMPLEMENTARY_LABEL_FILTER
        ? `NOT ${exists}` : exists);
    } else {
      const key = parseWa2LabelKey(labelId);
      if (!key) {
        where.push('1 = 0');
      } else {
        values.push(key.instanceId);
        const instanceValue = values.length;
        values.push(key.remoteLabelId);
        const labelValue = values.length;
        where.push(currentWa2LabelExists({
          instanceId: instanceValue,
          remoteLabelId: labelValue,
        }));
      }
    }
  }
  if (attributed === 'yes') where.push('leads.meta_lead_id IS NOT NULL');
  if (attributed === 'no') where.push('leads.meta_lead_id IS NULL');
  if (validPhone === 'yes') {
    where.push('COALESCE(leads.phone_normalized, leads.whatsapp_normalized) IS NOT NULL');
  }
  if (validPhone === 'no') {
    where.push('COALESCE(leads.phone_normalized, leads.whatsapp_normalized) IS NULL');
  }
  if (unattended === 'yes') where.push('leads.first_contact_at IS NULL');

  if (createdAfter) {
    values.push(createdAfter);
    where.push(`COALESCE(leads.received_at, leads.created_at) >= $${values.length}`);
  }
  if (createdBefore) {
    values.push(createdBefore);
    where.push(`COALESCE(leads.received_at, leads.created_at) <= $${values.length}`);
  }

  const orderBy = {
    recent: 'COALESCE(leads.received_at, leads.created_at) DESC',
    oldest: 'COALESCE(leads.received_at, leads.created_at) ASC',
    stage: 'leads.stage, leads.updated_at DESC',
    unattended: 'leads.first_contact_at NULLS FIRST, leads.received_at DESC',
    updated: 'leads.updated_at DESC',
    conversation: `COALESCE((
      SELECT max(history.changed_at)
      FROM lead_stage_history history
      WHERE history.tenant_id = leads.tenant_id
        AND history.lead_id = leads.id
        AND history.activity_type = 'WHATSAPP_OPENED'
    ), leads.received_at, leads.created_at) DESC`,
  }[sort] || 'COALESCE(leads.received_at, leads.created_at) DESC';
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
  const limitIndex = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const result = await pool.query(
    `${currentWa2LabelsCte()}
     SELECT leads.*,
       connection.name AS meta_connection_name,
       connection.business_id AS meta_business_id,
       page.name AS meta_page_name,
       form_record.name AS meta_form_name,
       (
         SELECT instance.name
         FROM wa2_contact_links link
         JOIN wa2_instances instance
           ON instance.tenant_id = link.tenant_id
          AND instance.id = link.wa2_instance_id
         WHERE link.tenant_id = leads.tenant_id
           AND link.lead_id = leads.id
           AND link.unlinked_at IS NULL
         ORDER BY instance.is_default DESC, instance.created_at
         LIMIT 1
       ) AS wa2_instance_name
       , wa2_labels.labels AS wa2_labels
       , wa2_labels.last_sync_at AS wa2_labels_synced_at
       , meta_status.mql_status, meta_status.opportunity_status
     FROM leads
     LEFT JOIN meta_connections connection
       ON connection.tenant_id = leads.tenant_id
      AND connection.id = leads.meta_connection_id
     LEFT JOIN meta_pages page
       ON page.tenant_id = leads.tenant_id
      AND page.page_id = leads.meta_page_id
     LEFT JOIN meta_forms form_record
       ON form_record.tenant_id = leads.tenant_id
      AND form_record.form_id = leads.meta_form_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', current.remote_label_id, 'name', current.remote_label_name)
                        ORDER BY current.remote_label_name) AS labels,
              max(current.received_at) AS last_sync_at
       FROM current_wa2_labels current
       WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
         AND current.remote_label_id IS NOT NULL AND current.operation = 'APPLY'
     ) wa2_labels ON true
     LEFT JOIN LATERAL (
       SELECT
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id = leads.tenant_id AND event.lead_id = leads.id
            AND event.event_id = concat('crm:', leads.id, ':marketing_qualified_lead:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_status,
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id = leads.tenant_id AND event.lead_id = leads.id
            AND event.event_id = concat('crm:', leads.id, ':sales_opportunity:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS opportunity_status
     ) meta_status ON true
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${orderBy} LIMIT $${limitIndex} OFFSET $${values.length}`,
    values,
  );
  return result.rows;
}

export async function getLeadById(id) {
  const currentMetaMode = process.env.META_TEST_MODE === 'true' ? 'test' : 'live';
  const result = await pool.query(
    `${currentWa2LabelsCte()}
     SELECT leads.*,
       instance.name AS wa2_instance_name,
       labels.labels AS wa2_labels, labels.last_sync_at AS wa2_labels_synced_at,
       meta_status.mql_status, meta_status.opportunity_status
     FROM leads
     LEFT JOIN LATERAL (
       SELECT instance.name FROM wa2_contact_links link JOIN wa2_instances instance
         ON instance.tenant_id = link.tenant_id AND instance.id = link.wa2_instance_id
        WHERE link.tenant_id = leads.tenant_id AND link.lead_id = leads.id AND link.unlinked_at IS NULL
        ORDER BY instance.is_default DESC, instance.created_at LIMIT 1
     ) instance ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', current.remote_label_id, 'name', current.remote_label_name)
                        ORDER BY current.remote_label_name) AS labels, max(current.received_at) AS last_sync_at
       FROM current_wa2_labels current
       WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
         AND current.operation = 'APPLY'
     ) labels ON true
     LEFT JOIN LATERAL (
       SELECT
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id=leads.tenant_id AND event.lead_id=leads.id
            AND event.event_id = concat('crm:', leads.id, ':marketing_qualified_lead:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_status,
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id=leads.tenant_id AND event.lead_id=leads.id
            AND event.event_id = concat('crm:', leads.id, ':sales_opportunity:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS opportunity_status
     ) meta_status ON true
     WHERE leads.id = $1 AND leads.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export function encodeLeadChangesCursor(changedAt, leadId) {
  return Buffer.from(JSON.stringify({ changedAt: new Date(changedAt).toISOString(), leadId }), 'utf8').toString('base64url');
}

const EMPTY_LEAD_CURSOR = '00000000-0000-0000-0000-000000000000';
export function decodeLeadChangesCursor(value) {
  if (!value) return { changedAt: new Date(0), leadId: EMPTY_LEAD_CURSOR };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const changedAt = new Date(parsed.changedAt);
    if (!parsed.leadId || !Number.isFinite(changedAt.getTime())) throw new Error('invalid cursor');
    return { changedAt, leadId: String(parsed.leadId) };
  } catch {
    const changedAt = new Date(value);
    if (Number.isFinite(changedAt.getTime())) return { changedAt, leadId: EMPTY_LEAD_CURSOR };
    throw new Error('INVALID_CURSOR');
  }
}

export async function listLeadChangesSince(cursorValue = null, limit = 50) {
  const cursor = decodeLeadChangesCursor(cursorValue);
  const result = await pool.query(
    `WITH changes AS (
       SELECT id AS lead_id, updated_at AS changed_at FROM leads WHERE tenant_id = $1
       UNION ALL SELECT lead_id, changed_at FROM lead_stage_history WHERE tenant_id = $1
       UNION ALL
       SELECT action.lead_id, receipt.received_at
       FROM wa2_inbound_label_actions action
       JOIN wa2_label_event_receipts receipt
         ON receipt.tenant_id = action.tenant_id AND receipt.id = action.receipt_id
       WHERE action.tenant_id = $1 AND action.lead_id IS NOT NULL
       UNION ALL
       SELECT action.lead_id, action.processed_at
       FROM wa2_inbound_label_actions action
       WHERE action.tenant_id = $1 AND action.lead_id IS NOT NULL AND action.processed_at IS NOT NULL
       UNION ALL SELECT lead_id, updated_at FROM meta_conversion_events WHERE tenant_id = $1
     )
     SELECT lead_id, MAX(changed_at) AS changed_at
     FROM changes WHERE lead_id IS NOT NULL AND (changed_at, lead_id) > ($2, $3)
     GROUP BY lead_id ORDER BY changed_at ASC, lead_id ASC LIMIT $4`,
    [tenantId(), cursor.changedAt, cursor.leadId, Math.min(Math.max(Number(limit) || 50, 1), 100) + 1],
  );
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const hasMore = result.rows.length > max;
  const selected = hasMore ? result.rows.slice(0, max) : result.rows;
  const last = selected.at(-1);
  return {
    hasMore,
    nextCursor: last ? encodeLeadChangesCursor(last.changed_at, last.lead_id) : cursorValue,
    changes: selected.map((row) => ({ leadId: row.lead_id, changedAt: new Date(row.changed_at).toISOString() })),
  };
}

export async function getTenantWhatsAppMessage() {
  const result = await pool.query(
    `SELECT whatsapp_initial_message FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId()],
  );
  return result.rows[0]?.whatsapp_initial_message ||
    'Olá, {{nome}}! Tudo bem? Sou da Super Educar e estou entrando em contato sobre seu interesse em nossos cursos.';
}

export async function setTenantWhatsAppMessage(message) {
  const result = await pool.query(
    `INSERT INTO tenant_settings (tenant_id, whatsapp_initial_message)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET
       whatsapp_initial_message = EXCLUDED.whatsapp_initial_message,
       updated_at = now()
     RETURNING whatsapp_initial_message`,
    [tenantId(), String(message).trim()],
  );
  return result.rows[0]?.whatsapp_initial_message || null;
}

export async function recordWhatsAppOpened(leadId, actor) {
  const result = await pool.query(
    `INSERT INTO lead_stage_history (
       tenant_id, lead_id, previous_stage, new_stage, origin, changed_by,
       observation, activity_type
     )
     SELECT tenant_id, id, stage, stage, 'MANUAL', $3,
            'Conversa aberta no WhatsApp pelo CRM.', 'WHATSAPP_OPENED'
     FROM leads
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), leadId, safeActor(actor)],
  );
  return result.rows[0] || null;
}

export async function listLeadHistory(leadId, limit = 200) {
  const result = await pool.query(
    `SELECT history.*
     FROM lead_stage_history history
     WHERE history.tenant_id = $1 AND history.lead_id = $2
     ORDER BY history.changed_at DESC
     LIMIT $3`,
    [tenantId(), leadId, Math.min(Math.max(Number(limit) || 200, 1), 500)],
  );
  return result.rows;
}

export async function upsertLead(input, { client = pool } = {}) {
  const currentTenantId = input.tenantId || tenantId();
  const phoneNormalized = normalizeWhatsAppPhoneOrNull(
    input.phoneNormalized || input.phone || input.whatsappNormalized || input.whatsapp,
  );

  if (input.metaLeadId) {
    const result = await client.query(
      `INSERT INTO leads (
        tenant_id, name, email, phone, phone_normalized, course, city, source, stage,
        meta_lead_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id,
        meta_campaign_id, meta_created_at, received_at, raw_meta,
        meta_connection_id, business_id, ad_account_id, dataset_id, source_created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23
      )
      ON CONFLICT (tenant_id, meta_lead_id) WHERE meta_lead_id IS NOT NULL
      DO UPDATE SET
        name = CASE
          WHEN NULLIF(EXCLUDED.name, '') IS NOT NULL AND EXCLUDED.name <> 'Lead Meta'
            THEN EXCLUDED.name
          ELSE leads.name
        END,
        email = COALESCE(NULLIF(EXCLUDED.email, ''), leads.email),
        phone = CASE
          WHEN EXCLUDED.phone_normalized IS NOT NULL THEN EXCLUDED.phone
          ELSE leads.phone
        END,
        phone_normalized = CASE
          WHEN EXCLUDED.phone_normalized IS NOT NULL THEN EXCLUDED.phone_normalized
          ELSE leads.phone_normalized
        END,
        course = COALESCE(NULLIF(EXCLUDED.course, ''), leads.course),
        city = COALESCE(NULLIF(EXCLUDED.city, ''), leads.city),
        meta_page_id = COALESCE(NULLIF(EXCLUDED.meta_page_id, ''), leads.meta_page_id),
        meta_form_id = COALESCE(EXCLUDED.meta_form_id, leads.meta_form_id),
        meta_ad_id = COALESCE(EXCLUDED.meta_ad_id, leads.meta_ad_id),
        meta_adset_id = COALESCE(EXCLUDED.meta_adset_id, leads.meta_adset_id),
        meta_campaign_id = COALESCE(EXCLUDED.meta_campaign_id, leads.meta_campaign_id),
        meta_connection_id = COALESCE(EXCLUDED.meta_connection_id, leads.meta_connection_id),
        business_id = COALESCE(EXCLUDED.business_id, leads.business_id),
        ad_account_id = COALESCE(EXCLUDED.ad_account_id, leads.ad_account_id),
        dataset_id = COALESCE(EXCLUDED.dataset_id, leads.dataset_id),
        source_created_at = COALESCE(EXCLUDED.source_created_at, leads.source_created_at),
        meta_created_at = COALESCE(EXCLUDED.meta_created_at, leads.meta_created_at),
        received_at = COALESCE(leads.received_at, EXCLUDED.received_at),
        raw_meta = COALESCE(EXCLUDED.raw_meta, leads.raw_meta),
        updated_at = now()
      RETURNING *, (xmax = 0) AS was_inserted`,
      [
        currentTenantId,
        input.name,
        input.email || null,
        input.phone || null,
        phoneNormalized,
        input.course || null,
        input.city || null,
        input.source || 'META_INSTANT_FORM',
        input.stage || 'NEW',
        String(input.metaLeadId),
        input.metaPageId ? String(input.metaPageId) : null,
        input.metaFormId || null,
        input.metaAdId || null,
        input.metaAdsetId || null,
        input.metaCampaignId || null,
        input.metaCreatedAt || null,
        input.receivedAt || new Date(),
        input.rawMeta || null,
        input.metaConnectionId || null,
        input.businessId || null,
        input.adAccountId || null,
        input.datasetId || null,
        input.sourceCreatedAt || input.metaCreatedAt || null,
      ],
    );
    const lead = result.rows[0];
    if (lead.was_inserted) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type
         ) VALUES (
           $1,$2,$3,$3,'META_WEBHOOK','Lead recebido da Meta.','LEAD_RECEIVED'
         )`,
        [currentTenantId, lead.id, lead.stage],
      );
    }
    return lead;
  }

  const result = await client.query(
    `INSERT INTO leads (
       tenant_id, name, email, phone, phone_normalized, course, city, source, stage
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      currentTenantId,
      input.name,
      input.email || null,
      input.phone || null,
      phoneNormalized,
      input.course || null,
      input.city || null,
      input.source || 'MANUAL',
      input.stage || 'NEW',
    ],
  );
  const lead = result.rows[0];
  await client.query(
    `INSERT INTO lead_stage_history (
       tenant_id, lead_id, previous_stage, new_stage, origin,
       observation, activity_type
     ) VALUES (
       $1,$2,$3,$3,'MANUAL','Lead cadastrado manualmente.','LEAD_RECEIVED'
     )`,
    [currentTenantId, lead.id, lead.stage],
  );
  return lead;
}

function serializeJsonb(value, fallback) {
  const candidate = value === undefined ? fallback : value;
  const serialized = JSON.stringify(candidate);
  if (serialized === undefined) {
    throw new TypeError('Valor JSONB não serializável');
  }
  return serialized;
}

function leadFileImportSummary(row) {
  return {
    total: Number(row.total_count || 0),
    new: Number(row.new_count || 0),
    update: Number(row.update_count || 0),
    possibleDuplicate: Number(row.possible_duplicate_count || 0),
    invalid: Number(row.invalid_count || 0),
    applied: Number(row.applied_count || 0),
  };
}

export async function getLeadFileImport(importId, { client = pool, includeItems = true } = {}) {
  const currentTenantId = tenantId();
  const result = await client.query(
    `SELECT * FROM lead_file_imports WHERE tenant_id = $1 AND id = $2`,
    [currentTenantId, importId],
  );
  const imported = result.rows[0];
  if (!imported) return null;
  let items = [];
  if (includeItems) {
    const itemResult = await client.query(
      `SELECT * FROM lead_file_import_items
       WHERE tenant_id = $1 AND import_id = $2
       ORDER BY row_number
       LIMIT 2000`,
      [currentTenantId, importId],
    );
    items = itemResult.rows;
  }
  return { ...imported, counts: leadFileImportSummary(imported), items };
}

export async function createLeadFileImportPreview(parsedFile, actor) {
  const currentTenantId = tenantId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id FROM lead_file_imports
       WHERE tenant_id = $1 AND sha256 = $2 AND sheet_name = $3
         AND status IN ('PREVIEW', 'PROCESSING', 'COMPLETED')`,
      [currentTenantId, parsedFile.sha256, parsedFile.sheetName],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return getLeadFileImport(existing.rows[0].id);
    }

    const metaLeadIds = [...new Set(parsedFile.rows.map((row) => row.metaLeadId).filter(Boolean))];
    const phones = [...new Set(parsedFile.rows.map((row) => row.phoneNormalized).filter(Boolean))];
    const leadResult = await client.query(
      `SELECT id, meta_lead_id, phone_normalized, whatsapp_normalized
       FROM leads
       WHERE tenant_id = $1
         AND (
           meta_lead_id = ANY($2::text[])
           OR COALESCE(phone_normalized, whatsapp_normalized) = ANY($3::text[])
         )`,
      [currentTenantId, metaLeadIds, phones],
    );
    const byMetaId = new Map();
    const byPhone = new Map();
    for (const lead of leadResult.rows) {
      if (lead.meta_lead_id) byMetaId.set(lead.meta_lead_id, lead);
      const phone = lead.phone_normalized || lead.whatsapp_normalized;
      if (phone && !byPhone.has(phone)) byPhone.set(phone, lead);
    }

    const seenMetaIds = new Set();
    const seenPhones = new Set();
    const classifiedRows = parsedFile.rows.map((row) => {
      const metaMatch = row.metaLeadId ? byMetaId.get(row.metaLeadId) : null;
      const phoneMatch = row.phoneNormalized ? byPhone.get(row.phoneNormalized) : null;
      const errors = [...row.errors];
      if (row.metaLeadId && seenMetaIds.has(row.metaLeadId)) {
        errors.push('DUPLICATE_META_ID_IN_FILE');
      }
      const decision = errors.length
        ? 'INVALID'
        : metaMatch
          ? 'UPDATE'
          : phoneMatch || (row.phoneNormalized && seenPhones.has(row.phoneNormalized))
            ? 'POSSIBLE_DUPLICATE'
            : 'NEW';
      if (row.metaLeadId) seenMetaIds.add(row.metaLeadId);
      if (row.phoneNormalized) seenPhones.add(row.phoneNormalized);
      return {
        ...row,
        errors,
        decision,
        existingLeadId: metaMatch?.id || phoneMatch?.id || null,
      };
    });
    const counts = classifiedRows.reduce((summary, row) => {
      summary.total += 1;
      if (row.decision === 'NEW') summary.new += 1;
      if (row.decision === 'UPDATE') summary.update += 1;
      if (row.decision === 'POSSIBLE_DUPLICATE') summary.possibleDuplicate += 1;
      if (row.decision === 'INVALID') summary.invalid += 1;
      return summary;
    }, { total: 0, new: 0, update: 0, possibleDuplicate: 0, invalid: 0 });

    const importResult = await client.query(
      `INSERT INTO lead_file_imports (
         tenant_id, status, original_filename, sha256, format, sheet_name,
         total_count, new_count, update_count, possible_duplicate_count,
         invalid_count, created_by, summary
       ) VALUES (
         $1,'PREVIEW',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
       ) RETURNING id`,
      [
        currentTenantId,
        parsedFile.filename,
        parsedFile.sha256,
        parsedFile.format,
        parsedFile.sheetName,
        counts.total,
        counts.new,
        counts.update,
        counts.possibleDuplicate,
        counts.invalid,
        String(actor || 'admin').slice(0, 200),
        serializeJsonb(counts, {}),
      ],
    );
    const importId = importResult.rows[0].id;
    for (const row of classifiedRows) {
      await client.query(
        `INSERT INTO lead_file_import_items (
           tenant_id, import_id, row_number, meta_lead_id, name, phone,
           phone_normalized, meta_created_at, meta_ad_id, meta_adset_id,
           meta_campaign_id, meta_form_id, raw_meta, decision, errors,
           existing_lead_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )`,
        [
          currentTenantId,
          importId,
          row.rowNumber,
          row.metaLeadId || null,
          row.name || null,
          row.phone || null,
          row.phoneNormalized || null,
          row.metaCreatedAt || null,
          row.metaAdId || null,
          row.metaAdsetId || null,
          row.metaCampaignId || null,
          row.metaFormId || null,
          serializeJsonb(row.rawMeta, {}),
          row.decision,
          serializeJsonb(row.errors, []),
          row.existingLeadId,
        ],
      );
    }
    await client.query('COMMIT');
    return getLeadFileImport(importId);
  } catch (error) {
    await client.query('ROLLBACK');
    if (
      error?.code === '23505' &&
      error?.constraint === 'lead_file_imports_active_hash_uidx'
    ) {
      const concurrent = await client.query(
        `SELECT id FROM lead_file_imports
         WHERE tenant_id = $1 AND sha256 = $2 AND sheet_name = $3
           AND status IN ('PREVIEW', 'PROCESSING', 'COMPLETED')`,
        [currentTenantId, parsedFile.sha256, parsedFile.sheetName],
      );
      if (concurrent.rows[0]) return getLeadFileImport(concurrent.rows[0].id);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmLeadFileImport(importId, actor) {
  const currentTenantId = tenantId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT * FROM lead_file_imports
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [currentTenantId, importId],
    );
    const imported = result.rows[0];
    if (!imported) {
      await client.query('ROLLBACK');
      return null;
    }
    if (imported.status === 'COMPLETED') {
      await client.query('COMMIT');
      return { ...imported, counts: leadFileImportSummary(imported), idempotent: true };
    }
    if (imported.status !== 'PREVIEW') {
      await client.query('ROLLBACK');
      return { ...imported, counts: leadFileImportSummary(imported), unavailable: true };
    }
    await client.query(
      `UPDATE lead_file_imports
       SET status = 'PROCESSING', confirmed_at = now(),
           summary = summary || jsonb_build_object('confirmedBy', $3::text)
       WHERE tenant_id = $1 AND id = $2`,
      [currentTenantId, importId, String(actor || 'admin').slice(0, 200)],
    );
    const items = await client.query(
      `SELECT * FROM lead_file_import_items
       WHERE tenant_id = $1 AND import_id = $2
       ORDER BY row_number`,
      [currentTenantId, importId],
    );
    let applied = 0;
    let created = 0;
    let updated = 0;
    for (const item of items.rows) {
      if (!['NEW', 'UPDATE'].includes(item.decision)) continue;
      const lead = await upsertLead({
        tenantId: currentTenantId,
        name: item.name,
        phone: item.phone,
        phoneNormalized: item.phone_normalized,
        source: 'META_INSTANT_FORM',
        stage: 'NEW',
        metaLeadId: item.meta_lead_id,
        metaFormId: item.meta_form_id,
        metaAdId: item.meta_ad_id,
        metaAdsetId: item.meta_adset_id,
        metaCampaignId: item.meta_campaign_id,
        metaCreatedAt: item.meta_created_at,
        sourceCreatedAt: item.meta_created_at,
        rawMeta: item.raw_meta,
      }, { client });
      applied += 1;
      if (item.decision === 'NEW') created += 1;
      if (item.decision === 'UPDATE') updated += 1;
      await client.query(
        `UPDATE lead_file_import_items
         SET applied_lead_id = $3, applied_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [currentTenantId, item.id, lead.id],
      );
    }
    const summary = {
      ...leadFileImportSummary(imported),
      applied,
      created,
      updated,
      possibleDuplicatesSkipped: Number(imported.possible_duplicate_count || 0),
      invalidSkipped: Number(imported.invalid_count || 0),
    };
    const completed = await client.query(
      `UPDATE lead_file_imports
       SET status = 'COMPLETED', applied_count = $3, completed_at = now(),
           summary = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [currentTenantId, importId, applied, serializeJsonb(summary, {})],
    );
    await client.query('COMMIT');
    return {
      ...completed.rows[0],
      counts: leadFileImportSummary(completed.rows[0]),
      idempotent: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelLeadFileImport(importId) {
  const result = await pool.query(
    `UPDATE lead_file_imports
     SET status = 'CANCELLED',
         summary = summary || '{"cancelled": true}'::jsonb
     WHERE tenant_id = $1 AND id = $2 AND status = 'PREVIEW'
     RETURNING id`,
    [tenantId(), importId],
  );
  return result.rowCount === 1;
}

export async function listPhoneNormalizationConflicts() {
  const result = await pool.query(
    `SELECT phone_normalized, count(*)::int AS lead_count,
            array_agg(id ORDER BY created_at) AS lead_ids
     FROM leads
     WHERE tenant_id = $1 AND phone_normalized IS NOT NULL
     GROUP BY phone_normalized
     HAVING count(*) > 1
     ORDER BY count(*) DESC, phone_normalized`,
    [tenantId()],
  );
  return result.rows;
}

export async function listMetaConnections() {
  const result = await pool.query(
    `SELECT connection.*,
       (SELECT count(*)::int FROM meta_pages page
        WHERE page.tenant_id = connection.tenant_id
          AND page.meta_connection_id = connection.id) AS page_count,
       (SELECT count(*)::int
        FROM meta_forms form_record
        JOIN meta_pages page
          ON page.tenant_id = form_record.tenant_id
         AND page.id = form_record.meta_page_id
        WHERE page.tenant_id = connection.tenant_id
          AND page.meta_connection_id = connection.id) AS form_count,
       (SELECT count(*)::int FROM meta_datasets dataset
        WHERE dataset.tenant_id = connection.tenant_id
          AND dataset.meta_connection_id = connection.id) AS dataset_count
     FROM meta_connections connection
     WHERE connection.tenant_id = $1
     ORDER BY connection.active DESC, connection.name`,
    [tenantId()],
  );
  return result.rows;
}

export async function getMetaConnectionById(id) {
  const [connection, pages, forms, datasets] = await Promise.all([
    pool.query(
      `SELECT * FROM meta_connections WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), id],
    ),
    pool.query(
      `SELECT * FROM meta_pages
       WHERE tenant_id = $1 AND meta_connection_id = $2
       ORDER BY active DESC, name`,
      [tenantId(), id],
    ),
    pool.query(
      `SELECT form_record.*, page.name AS page_name, page.page_id
       FROM meta_forms form_record
       JOIN meta_pages page
         ON page.tenant_id = form_record.tenant_id
        AND page.id = form_record.meta_page_id
       WHERE form_record.tenant_id = $1 AND page.meta_connection_id = $2
       ORDER BY form_record.active DESC, page.name, form_record.name`,
      [tenantId(), id],
    ),
    pool.query(
      `SELECT * FROM meta_datasets
       WHERE tenant_id = $1 AND meta_connection_id = $2
       ORDER BY active DESC, name`,
      [tenantId(), id],
    ),
  ]);
  if (!connection.rows[0]) return null;
  return {
    ...connection.rows[0],
    pages: pages.rows,
    forms: forms.rows,
    datasets: datasets.rows,
  };
}

export async function createMetaConnection({
  name,
  businessId,
  adAccountId,
  appId,
  encryptedAccessToken,
  encryptedAppSecret,
}) {
  const result = await pool.query(
    `INSERT INTO meta_connections (
       tenant_id, name, business_id, ad_account_id, app_id,
       encrypted_access_token, encrypted_app_secret
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      tenantId(), name, businessId, adAccountId || null, appId || null,
      encryptedAccessToken, encryptedAppSecret || null,
    ],
  );
  return result.rows[0];
}

export async function updateMetaConnectionValidation(id, {
  status,
  error = null,
  validated = false,
}) {
  const result = await pool.query(
    `UPDATE meta_connections
     SET status = $3, last_error = $4,
         last_validated_at = CASE WHEN $5 THEN now() ELSE last_validated_at END,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, status, error ? String(error).slice(0, 500) : null, validated],
  );
  return result.rows[0] || null;
}

export async function updateMetaConnectionName(id, name) {
  const result = await pool.query(
    `UPDATE meta_connections
     SET name = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, String(name).trim()],
  );
  return result.rows[0] || null;
}

export async function setMetaConnectionActive(id, active) {
  const result = await pool.query(
    `UPDATE meta_connections
     SET active = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, active === true],
  );
  return result.rows[0] || null;
}

export async function replaceMetaConnectionAccessToken(id, encryptedAccessToken) {
  const result = await pool.query(
    `UPDATE meta_connections
     SET encrypted_access_token = $3, status = 'VALID',
         last_validated_at = now(), last_error = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, encryptedAccessToken],
  );
  return result.rows[0] || null;
}

export async function upsertMetaPage({ connectionId, pageId, name }) {
  const result = await pool.query(
    `INSERT INTO meta_pages (
       tenant_id, meta_connection_id, page_id, name
     )
     SELECT $1, id, $3, $4
     FROM meta_connections
     WHERE tenant_id = $1 AND id = $2 AND active = true
     ON CONFLICT (tenant_id, page_id) DO UPDATE SET
       name = EXCLUDED.name,
       active = true,
       updated_at = now()
     WHERE meta_pages.meta_connection_id = EXCLUDED.meta_connection_id
     RETURNING *`,
    [tenantId(), connectionId, pageId, name],
  );
  if (!result.rows[0]) throw new Error('Conexão Meta inválida ou página pertence a outra conexão');
  return result.rows[0];
}

export async function upsertMetaForm({ pageRecordId, formId, name }) {
  const result = await pool.query(
    `INSERT INTO meta_forms (tenant_id, meta_page_id, form_id, name)
     SELECT $1, id, $3, $4
     FROM meta_pages
     WHERE tenant_id = $1 AND id = $2 AND active = true
     ON CONFLICT (tenant_id, form_id) DO UPDATE SET
       name = EXCLUDED.name,
       active = true,
       updated_at = now()
     WHERE meta_forms.meta_page_id = EXCLUDED.meta_page_id
     RETURNING *`,
    [tenantId(), pageRecordId, formId, name],
  );
  if (!result.rows[0]) throw new Error('Página Meta inválida ou formulário pertence a outra página');
  return result.rows[0];
}

export async function upsertMetaDataset({
  connectionId,
  datasetId,
  name,
  encryptedTestEventCode = null,
}) {
  const result = await pool.query(
    `INSERT INTO meta_datasets (
       tenant_id, meta_connection_id, dataset_id, name, encrypted_test_event_code
     )
     SELECT $1, id, $3, $4, $5
     FROM meta_connections
     WHERE tenant_id = $1 AND id = $2 AND active = true
     ON CONFLICT (tenant_id, dataset_id) DO UPDATE SET
       name = EXCLUDED.name,
       encrypted_test_event_code = COALESCE(
         EXCLUDED.encrypted_test_event_code,
         meta_datasets.encrypted_test_event_code
       ),
       active = true,
       updated_at = now()
     WHERE meta_datasets.meta_connection_id = EXCLUDED.meta_connection_id
     RETURNING *`,
    [tenantId(), connectionId, datasetId, name, encryptedTestEventCode],
  );
  if (!result.rows[0]) throw new Error('Conexão Meta inválida ou dataset pertence a outra conexão');
  return result.rows[0];
}

export async function updateMetaDatasetValidation(id, {
  valid,
  errorMessage = null,
}) {
  const result = await pool.query(
    `UPDATE meta_datasets
     SET last_test_at = now(),
         last_error = CASE WHEN $3 THEN NULL ELSE left($4, 500) END,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, valid, errorMessage],
  );
  return result.rows[0] || null;
}

export async function getMetaSourceContext({
  sourceTenantId = tenantId(),
  pageId,
  formId = null,
}) {
  const result = await pool.query(
    `SELECT connection.*, page.id AS meta_page_record_id, page.page_id,
            form_record.id AS meta_form_record_id, form_record.form_id,
            dataset.id AS meta_dataset_record_id, dataset.dataset_id,
            dataset.encrypted_test_event_code
     FROM meta_pages page
     JOIN meta_connections connection
       ON connection.tenant_id = page.tenant_id
      AND connection.id = page.meta_connection_id
      AND connection.active = true
      AND connection.status = 'VALID'
     LEFT JOIN meta_forms form_record
       ON form_record.tenant_id = page.tenant_id
      AND form_record.meta_page_id = page.id
      AND form_record.active = true
      AND ($3::text IS NULL OR form_record.form_id = $3)
     LEFT JOIN LATERAL (
       SELECT candidate.*
       FROM meta_datasets candidate
       WHERE candidate.tenant_id = connection.tenant_id
         AND candidate.meta_connection_id = connection.id
         AND candidate.active = true
       ORDER BY candidate.created_at
       LIMIT 1
     ) dataset ON true
     WHERE page.tenant_id = $1
       AND page.page_id = $2
       AND page.active = true
       AND ($3::text IS NULL OR form_record.id IS NOT NULL)
     LIMIT 1`,
    [sourceTenantId, String(pageId || ''), formId ? String(formId) : null],
  );
  return result.rows[0] || null;
}

export async function listMetaImportForms() {
  const result = await pool.query(
    `SELECT form_record.id, form_record.form_id, form_record.name,
            page.id AS page_record_id, page.page_id, page.name AS page_name,
            connection.id AS connection_id, connection.name AS connection_name
     FROM meta_forms form_record
     JOIN meta_pages page
       ON page.tenant_id = form_record.tenant_id
      AND page.id = form_record.meta_page_id
      AND page.active = true
     JOIN meta_connections connection
       ON connection.tenant_id = page.tenant_id
      AND connection.id = page.meta_connection_id
      AND connection.active = true
      AND connection.status = 'VALID'
     WHERE form_record.tenant_id = $1 AND form_record.active = true
     ORDER BY connection.name, page.name, form_record.name`,
    [tenantId()],
  );
  return result.rows;
}

export async function listWa2InstancesLocal({ enabledOnly = false } = {}) {
  const values = [tenantId()];
  const enabledFilter = enabledOnly ? 'AND enabled = true' : '';
  const result = await pool.query(
    `SELECT * FROM wa2_instances
     WHERE tenant_id = $1 ${enabledFilter}
     ORDER BY is_default DESC, name NULLS LAST, created_at`,
    values,
  );
  return result.rows;
}

export async function disableMissingWa2Instances(remoteInstanceIds) {
  const ids = [...new Set(
    (Array.isArray(remoteInstanceIds) ? remoteInstanceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
  const result = await pool.query(
    `UPDATE wa2_instances
     SET enabled = false,
         is_default = false,
         remote_status = 'REMOTE_DELETED',
         last_error = 'INSTANCE_NOT_FOUND',
         updated_at = now()
     WHERE tenant_id = $1
       AND enabled = true
       AND NOT (remote_instance_id = ANY($2::text[]))
     RETURNING *`,
    [tenantId(), ids],
  );
  return result.rows;
}

export async function disableWa2InstanceByRemoteId(remoteInstanceId) {
  const result = await pool.query(
    `UPDATE wa2_instances
     SET enabled = false,
         is_default = false,
         remote_status = 'REMOTE_DELETED',
         last_error = 'INSTANCE_NOT_FOUND',
         updated_at = now()
     WHERE tenant_id = $1 AND remote_instance_id = $2
     RETURNING *`,
    [tenantId(), String(remoteInstanceId)],
  );
  return result.rows[0] || null;
}

export async function getWa2InstanceLocalById(id) {
  const result = await pool.query(
    'SELECT * FROM wa2_instances WHERE id = $1 AND tenant_id = $2',
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function getDefaultWa2Instance() {
  const result = await pool.query(
    `SELECT * FROM wa2_instances
     WHERE tenant_id = $1 AND is_default = true AND enabled = true`,
    [tenantId()],
  );
  return result.rows[0] || null;
}

export async function listWa2LabelCatalog() {
  const result = await pool.query(
    `SELECT catalog.wa2_instance_id AS instance_id,
            catalog.instance_name,
            catalog.remote_label_id,
            COALESCE(MAX(catalog.remote_label_name), catalog.remote_label_id) AS remote_label_name,
            bool_or(catalog.official) AS official,
            bool_and(catalog.enabled) AS enabled
     FROM (
       SELECT binding.wa2_instance_id, instance.name AS instance_name,
              binding.remote_label_id, binding.remote_label_name,
              (binding.enabled = true) AS official, instance.enabled
       FROM wa2_label_bindings binding
       JOIN wa2_instances instance
         ON instance.tenant_id = binding.tenant_id AND instance.id = binding.wa2_instance_id
       WHERE binding.tenant_id = $1
         AND instance.enabled = true
       UNION ALL
       SELECT catalog.wa2_instance_id, instance.name AS instance_name,
              catalog.remote_label_id, catalog.remote_label_name,
              catalog.official, catalog.enabled
       FROM wa2_label_catalog catalog
       JOIN wa2_instances instance
         ON instance.tenant_id = catalog.tenant_id AND instance.id = catalog.wa2_instance_id
       WHERE catalog.tenant_id = $1
         AND instance.enabled = true
         AND catalog.enabled = true
       UNION ALL
       SELECT link.wa2_instance_id, instance.name AS instance_name,
              receipt.remote_label_id, receipt.remote_label_name,
              false AS official, instance.enabled
       FROM wa2_label_event_receipts receipt
       JOIN wa2_instances instance
         ON instance.tenant_id = receipt.tenant_id
        AND instance.remote_instance_id = receipt.remote_instance_id
       JOIN wa2_contact_links link
         ON link.tenant_id = receipt.tenant_id
        AND link.wa2_instance_id = instance.id
        AND link.remote_chat_id = receipt.remote_chat_id
        AND link.unlinked_at IS NULL
       WHERE receipt.tenant_id = $1
         AND instance.enabled = true
     ) catalog
     GROUP BY catalog.wa2_instance_id, catalog.instance_name, catalog.remote_label_id
     ORDER BY catalog.instance_name, bool_or(catalog.official) DESC, remote_label_name, catalog.remote_label_id`,
    [tenantId()],
  );
  return result.rows.map((row) => ({
    ...row,
    id: row.remote_label_id,
    name: row.remote_label_name,
  }));
}

export async function upsertWa2LabelCatalog(instanceId, labels = []) {
  const safeLabels = Array.isArray(labels)
    ? labels.filter((label) => label?.id && label?.name).slice(0, 500)
    : [];
  for (const label of safeLabels) {
    await pool.query(
      `INSERT INTO wa2_label_catalog (
         tenant_id, wa2_instance_id, remote_label_id, remote_label_name, official, updated_at
       ) VALUES ($1,$2,$3,$4,EXISTS (
         SELECT 1 FROM wa2_label_bindings binding
         WHERE binding.tenant_id=$1 AND binding.wa2_instance_id=$2
           AND binding.remote_label_id=$3 AND binding.enabled=true
       ),now())
       ON CONFLICT (tenant_id, wa2_instance_id, remote_label_id) DO UPDATE SET
         remote_label_name = EXCLUDED.remote_label_name,
         official = EXCLUDED.official,
         enabled = true,
         updated_at = now()`,
      [tenantId(), instanceId, String(label.id), String(label.name).trim().slice(0, 200)],
    );
  }
  return safeLabels.length;
}

export async function getWa2LabelFilterCounts({ createdAfter = operationStartAt() } = {}) {
  const values = [tenantId()];
  const where = ['leads.tenant_id = $1'];
  if (createdAfter) {
    values.push(createdAfter);
    where.push(`COALESCE(leads.received_at, leads.created_at) >= $${values.length}`);
  }
  const result = await pool.query(
    `${currentWa2LabelsCte()}
     SELECT count(*)::int AS eligible_total,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY'
       ))::int AS any_whatsapp,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY'
       ))::int AS none_whatsapp,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = false
       ))::int AS any_complementary,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = false
       ))::int AS none_complementary,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 01%'
       ))::int AS crm01,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 02%'
       ))::int AS crm02,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 03%'
       ))::int AS crm03,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 04%'
       ))::int AS crm04,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 05%'
       ))::int AS crm05,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM current_wa2_labels current
         WHERE current.tenant_id = leads.tenant_id AND current.lead_id = leads.id
           AND current.operation = 'APPLY' AND current.official = true
           AND current.remote_label_name ILIKE 'CRM 99%'
       ))::int AS crm99
     FROM leads
     WHERE ${where.join(' AND ')}`,
    values,
  );
  return result.rows[0];
}

function optionalActor(actor) {
  if (actor == null || actor === '') return null;
  const value = String(actor);
  if (value.length > 320) {
    throw new Wa2DataError('Ator inválido', 'WA2_ACTOR_INVALID');
  }
  return value;
}

export async function upsertVerifiedWa2Instance(remoteData, actor = null) {
  optionalActor(actor);
  const result = await pool.query(
    `INSERT INTO wa2_instances (
       tenant_id, remote_instance_id, name, role, phone, remote_status,
       last_verified_at, last_sync_at, last_error
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, NULL)
     ON CONFLICT (remote_instance_id) DO UPDATE SET
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       phone = EXCLUDED.phone,
       remote_status = EXCLUDED.remote_status,
       last_verified_at = now(),
       last_sync_at = COALESCE(EXCLUDED.last_sync_at, wa2_instances.last_sync_at),
       last_error = NULL,
       enabled = true,
       updated_at = now()
     WHERE wa2_instances.tenant_id = EXCLUDED.tenant_id
     RETURNING *`,
    [
      tenantId(),
      remoteData.id,
      remoteData.name || null,
      remoteData.role || null,
      remoteData.phone || null,
      remoteData.status || null,
      remoteData.updatedAt || null,
    ],
  );
  if (result.rowCount === 0) {
    throw new Wa2DataError(
      'Instância WA2 pertence a outro tenant',
      'WA2_INSTANCE_TENANT_CONFLICT',
    );
  }
  return result.rows[0];
}

export async function setDefaultWa2Instance(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM wa2_instances
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [id, tenantId()],
    );
    const instance = selected.rows[0];
    if (!instance) {
      throw new Wa2DataError('Instância local não encontrada', 'WA2_INSTANCE_NOT_FOUND');
    }
    if (!instance.enabled) {
      throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
    }
    await client.query(
      `UPDATE wa2_instances
       SET is_default = false, updated_at = now()
       WHERE tenant_id = $1 AND is_default = true AND id <> $2`,
      [tenantId(), id],
    );
    const updated = await client.query(
      `UPDATE wa2_instances
       SET is_default = true, updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId(), id],
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function enableWa2Instance(id) {
  const result = await pool.query(
    `UPDATE wa2_instances
     SET enabled = true, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function disableWa2Instance(id, { clearDefault = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM wa2_instances
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [id, tenantId()],
    );
    const instance = selected.rows[0];
    if (!instance) {
      await client.query('ROLLBACK');
      return null;
    }
    if (instance.is_default && !clearDefault) {
      throw new Wa2DataError(
        'Remova explicitamente a condição padrão antes de desabilitar',
        'WA2_DEFAULT_INSTANCE_CONFLICT',
      );
    }
    const updated = await client.query(
      `UPDATE wa2_instances
       SET enabled = false,
           is_default = CASE WHEN $3 THEN false ELSE is_default END,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId(), clearDefault],
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listWa2LabelBindings(instanceId = null) {
  const values = [tenantId()];
  let instanceFilter = '';
  if (instanceId) {
    values.push(instanceId);
    instanceFilter = `AND binding.wa2_instance_id = $${values.length}`;
  }
  const result = await pool.query(
    `SELECT binding.*, instance.name AS instance_name,
            instance.remote_instance_id, instance.enabled AS instance_enabled,
            (
              SELECT count(*)::int
              FROM leads lead
              JOIN wa2_contact_links link
                ON link.tenant_id = lead.tenant_id
               AND link.lead_id = lead.id
               AND link.wa2_instance_id = binding.wa2_instance_id
               AND link.unlinked_at IS NULL
              WHERE lead.tenant_id = binding.tenant_id
                AND lead.stage = binding.stage
            ) AS lead_count,
            last_attempt.status AS last_attempt_status,
            last_attempt.updated_at AS last_attempt_at,
            last_attempt.last_error_code AS last_attempt_error_code,
            last_attempt.last_error_message AS last_attempt_error,
            last_success.finished_at AS last_sync_at,
            last_success.finished_at AS last_success_at,
            last_error.updated_at AS last_error_at,
            last_error.last_error_code AS last_error_code,
            last_error.last_error_message AS last_error
     FROM wa2_label_bindings binding
     JOIN wa2_instances instance
       ON instance.id = binding.wa2_instance_id
      AND instance.tenant_id = binding.tenant_id
     LEFT JOIN LATERAL (
       SELECT job.status, job.updated_at, job.last_error_code,
              job.last_error_message
       FROM wa2_label_jobs job
       WHERE job.tenant_id = binding.tenant_id
         AND job.wa2_instance_id = binding.wa2_instance_id
         AND job.target_remote_label_id = binding.remote_label_id
       ORDER BY job.updated_at DESC, job.created_at DESC
       LIMIT 1
     ) last_attempt ON true
     LEFT JOIN LATERAL (
       SELECT job.finished_at
       FROM wa2_label_jobs job
       WHERE job.tenant_id = binding.tenant_id
         AND job.wa2_instance_id = binding.wa2_instance_id
         AND job.target_remote_label_id = binding.remote_label_id
         AND job.status = 'DONE'
       ORDER BY job.finished_at DESC NULLS LAST, job.updated_at DESC
       LIMIT 1
     ) last_success ON true
     LEFT JOIN LATERAL (
       SELECT job.updated_at, job.last_error_code, job.last_error_message
       FROM wa2_label_jobs job
       WHERE job.tenant_id = binding.tenant_id
         AND job.wa2_instance_id = binding.wa2_instance_id
         AND job.target_remote_label_id = binding.remote_label_id
         AND job.status = 'FAILED'
       ORDER BY job.updated_at DESC, job.created_at DESC
       LIMIT 1
     ) last_error ON true
     WHERE binding.tenant_id = $1 ${instanceFilter}
     ORDER BY instance.is_default DESC, instance.name NULLS LAST, binding.stage`,
    values,
  );
  return result.rows;
}

export async function getWa2LabelBindingById(id) {
  const result = await pool.query(
    `SELECT binding.*, instance.remote_instance_id,
            instance.enabled AS instance_enabled
     FROM wa2_label_bindings binding
     JOIN wa2_instances instance
       ON instance.id = binding.wa2_instance_id
      AND instance.tenant_id = binding.tenant_id
     WHERE binding.id = $1 AND binding.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function upsertWa2LabelBinding({
  instanceId,
  stage,
  remoteLabelId,
  remoteLabelName,
}) {
  if (!isWa2LabelStage(stage)) {
    throw new Wa2DataError('Etapa de etiqueta inválida', 'WA2_LABEL_STAGE_INVALID');
  }
  const stages = stagesSharingWa2Label(stage);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE id = $1 AND tenant_id = $2 AND enabled = true
       FOR UPDATE`,
      [instanceId, tenantId()],
    );
    if (!instanceResult.rows[0]) {
      throw new Wa2DataError(
        'Instância local não encontrada ou desabilitada',
        'WA2_INSTANCE_DISABLED',
      );
    }
    const saved = [];
    for (const bindingStage of stages) {
      const result = await client.query(
        `INSERT INTO wa2_label_bindings (
           tenant_id, wa2_instance_id, stage, remote_label_id,
           remote_label_name, enabled, last_verified_at
         ) VALUES ($1, $2, $3, $4, $5, true, now())
         ON CONFLICT (tenant_id, wa2_instance_id, stage) DO UPDATE SET
           remote_label_id = EXCLUDED.remote_label_id,
           remote_label_name = EXCLUDED.remote_label_name,
           enabled = true,
           last_verified_at = now(),
           updated_at = now()
         RETURNING *`,
        [tenantId(), instanceId, bindingStage, remoteLabelId, remoteLabelName],
      );
      saved.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setWa2LabelBindingEnabled(id, enabled) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM wa2_label_bindings
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [id, tenantId()],
    );
    const binding = selected.rows[0];
    if (!binding) {
      await client.query('ROLLBACK');
      return [];
    }
    const stages = stagesSharingWa2Label(binding.stage);
    const result = await client.query(
      `UPDATE wa2_label_bindings
       SET enabled = $4, updated_at = now()
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND stage = ANY($3::text[])
       RETURNING *`,
      [tenantId(), binding.wa2_instance_id, stages, enabled === true],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyWa2LabelBinding(id, remoteLabel) {
  const binding = await getWa2LabelBindingById(id);
  if (!binding || binding.remote_label_id !== remoteLabel.id) return [];
  const stages = stagesSharingWa2Label(binding.stage);
  const result = await pool.query(
    `UPDATE wa2_label_bindings
     SET remote_label_name = $4, last_verified_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND wa2_instance_id = $2
       AND stage = ANY($3::text[])
       AND remote_label_id = $5
     RETURNING *`,
    [
      tenantId(),
      binding.wa2_instance_id,
      stages,
      remoteLabel.name,
      remoteLabel.id,
    ],
  );
  return result.rows;
}

export async function getActiveWa2ContactLinkForLead(leadId, instanceId = null) {
  const values = [tenantId(), leadId];
  let instanceFilter = '';
  if (instanceId) {
    values.push(instanceId);
    instanceFilter = `AND link.wa2_instance_id = $${values.length}`;
  }
  const result = await pool.query(
    `SELECT link.*, instance.name AS instance_name,
            instance.remote_instance_id, instance.enabled AS instance_enabled
     FROM wa2_contact_links link
     JOIN wa2_instances instance
       ON instance.id = link.wa2_instance_id
      AND instance.tenant_id = link.tenant_id
     WHERE link.tenant_id = $1
       AND link.lead_id = $2
       AND link.unlinked_at IS NULL
       ${instanceFilter}
     ORDER BY link.created_at DESC`,
    values,
  );
  if (instanceId) return result.rows[0] || null;
  return result.rows;
}

export async function getWa2ContactLinkById(id) {
  const result = await pool.query(
    `SELECT link.*, instance.name AS instance_name,
            instance.remote_instance_id, instance.enabled AS instance_enabled
     FROM wa2_contact_links link
     JOIN wa2_instances instance
       ON instance.id = link.wa2_instance_id
      AND instance.tenant_id = link.tenant_id
     WHERE link.id = $1 AND link.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

async function lockWa2LinkParents(client, { leadId, instanceId, expectedPhoneNormalized }) {
  const leadResult = await client.query(
    `SELECT * FROM leads
     WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [leadId, tenantId()],
  );
  const lead = leadResult.rows[0];
  const instanceResult = await client.query(
    `SELECT * FROM wa2_instances
     WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [instanceId, tenantId()],
  );
  const instance = instanceResult.rows[0];
  return validateWa2LinkParents({
    tenantId: tenantId(),
    lead,
    instance,
    expectedPhoneNormalized,
  });
}

async function ensureNoActiveWa2LinkConflict(
  client,
  { leadId, instanceId, remoteChatId, excludeLinkId = null },
) {
  const result = await client.query(
    `SELECT id, lead_id, remote_chat_id
     FROM wa2_contact_links
     WHERE tenant_id = $1
       AND wa2_instance_id = $2
       AND unlinked_at IS NULL
       AND (lead_id = $3 OR remote_chat_id = $4)
       AND ($5::uuid IS NULL OR id <> $5)
     FOR UPDATE`,
    [tenantId(), instanceId, leadId, remoteChatId, excludeLinkId],
  );
  assertNoActiveWa2LinkConflict(result.rows);
}

async function insertWa2ContactLink(client, {
  leadId,
  instanceId,
  expectedPhoneNormalized,
  resolved,
  actor,
}) {
  const result = await client.query(
    `INSERT INTO wa2_contact_links (
       tenant_id, lead_id, wa2_instance_id, remote_contact_id,
       remote_chat_id, jid, phone_normalized, linked_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      tenantId(),
      leadId,
      instanceId,
      resolved.contact.id,
      resolved.chat.id,
      resolved.chat.jid,
      expectedPhoneNormalized,
      optionalActor(actor),
    ],
  );
  return result.rows[0];
}

function mapWa2UniqueViolation(error) {
  if (error?.code === '23505') {
    return new Wa2DataError('Já existe vínculo WA2 conflitante', 'WA2_LINK_CONFLICT');
  }
  return error;
}

export async function createWa2ContactLink({
  leadId,
  instanceId,
  expectedPhoneNormalized,
  resolved,
  actor = null,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWa2LinkParents(client, { leadId, instanceId, expectedPhoneNormalized });
    const currentResult = await client.query(
      `SELECT id FROM wa2_contact_links
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), leadId, instanceId],
    );
    if (currentResult.rowCount > 0) {
      throw new Wa2DataError(
        'O vínculo ativo mudou após a resolução inicial',
        'WA2_LINK_CHANGED',
      );
    }
    await ensureNoActiveWa2LinkConflict(client, {
      leadId,
      instanceId,
      remoteChatId: resolved.chat.id,
    });
    const link = await insertWa2ContactLink(client, {
      leadId,
      instanceId,
      expectedPhoneNormalized,
      resolved,
      actor,
    });
    await client.query('COMMIT');
    return link;
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapWa2UniqueViolation(error);
  } finally {
    client.release();
  }
}

export async function verifyWa2ContactLink({ linkId, resolved }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT link.*, lead.phone_normalized AS current_lead_phone,
              instance.enabled AS current_instance_enabled
       FROM wa2_contact_links link
       JOIN leads lead
         ON lead.id = link.lead_id AND lead.tenant_id = link.tenant_id
       JOIN wa2_instances instance
         ON instance.id = link.wa2_instance_id
        AND instance.tenant_id = link.tenant_id
       WHERE link.id = $1 AND link.tenant_id = $2 AND link.unlinked_at IS NULL
       FOR UPDATE OF link, lead, instance`,
      [linkId, tenantId()],
    );
    const link = selected.rows[0];
    if (!link) {
      throw new Wa2DataError('Vínculo ativo não encontrado', 'WA2_LINK_NOT_FOUND');
    }
    if (!link.current_instance_enabled) {
      throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
    }
    if (link.current_lead_phone !== link.phone_normalized) {
      throw new Wa2DataError(
        'O telefone do lead mudou durante a verificação',
        'WA2_LEAD_PHONE_CHANGED',
      );
    }
    if (
      link.remote_contact_id !== resolved.contact.id ||
      link.remote_chat_id !== resolved.chat.id ||
      link.jid !== resolved.chat.jid ||
      link.phone_normalized !== resolved.contact.phoneNormalized
    ) {
      throw new Wa2DataError('O contato ou chat remoto mudou', 'WA2_LINK_CHANGED');
    }
    const updated = await client.query(
      `UPDATE wa2_contact_links
       SET last_verified_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [linkId, tenantId()],
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function unlinkWa2ContactLink({
  linkId,
  actor = null,
  reason = 'Desvínculo manual confirmado.',
}) {
  const reasonText = String(reason || '');
  if (!reasonText || reasonText.length > 500) {
    throw new Wa2DataError('Motivo de desvínculo inválido', 'WA2_UNLINK_REASON_INVALID');
  }
  const result = await pool.query(
    `UPDATE wa2_contact_links
     SET unlinked_at = now(), unlinked_by = $3, unlink_reason = $4, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND unlinked_at IS NULL
     RETURNING *`,
    [linkId, tenantId(), optionalActor(actor), reasonText],
  );
  return result.rows[0] || null;
}

export async function replaceWa2ContactLink({
  leadId,
  instanceId,
  expectedLinkId,
  expectedPhoneNormalized,
  resolved,
  actor = null,
  reason = 'Vínculo substituído manualmente.',
}) {
  const reasonText = String(reason || '');
  if (!reasonText || reasonText.length > 500) {
    throw new Wa2DataError('Motivo de substituição inválido', 'WA2_UNLINK_REASON_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWa2LinkParents(client, { leadId, instanceId, expectedPhoneNormalized });
    const currentResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), leadId, instanceId],
    );
    const current = currentResult.rows[0];
    if (!current || current.id !== expectedLinkId) {
      throw new Wa2DataError(
        'O vínculo ativo mudou após a resolução inicial',
        'WA2_LINK_CHANGED',
      );
    }
    if (
      current.remote_contact_id === resolved.contact.id &&
      current.remote_chat_id === resolved.chat.id &&
      current.jid === resolved.chat.jid
    ) {
      const verified = await client.query(
        `UPDATE wa2_contact_links
         SET last_verified_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [current.id],
      );
      await client.query('COMMIT');
      return { replaced: false, link: verified.rows[0] };
    }
    await ensureNoActiveWa2LinkConflict(client, {
      leadId,
      instanceId,
      remoteChatId: resolved.chat.id,
      excludeLinkId: current.id,
    });
    await client.query(
      `UPDATE wa2_contact_links
       SET unlinked_at = now(), unlinked_by = $2,
           unlink_reason = $3, updated_at = now()
       WHERE id = $1`,
      [current.id, optionalActor(actor), reasonText],
    );
    const link = await insertWa2ContactLink(client, {
      leadId,
      instanceId,
      expectedPhoneNormalized,
      resolved,
      actor,
    });
    await client.query('COMMIT');
    return { replaced: true, link };
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapWa2UniqueViolation(error);
  } finally {
    client.release();
  }
}

async function createOrGetMetaEvent(client, { lead, eventName, eventTime, mode }) {
  const destination = lead.meta_connection_id
    ? await client.query(
      `SELECT connection.id AS meta_connection_id, dataset.id AS meta_dataset_id,
              dataset.dataset_id AS meta_dataset_value
       FROM meta_connections connection
       JOIN meta_datasets dataset
         ON dataset.tenant_id = connection.tenant_id
        AND dataset.meta_connection_id = connection.id
        AND dataset.active = true
       WHERE connection.tenant_id = $1
         AND connection.id = $2
         AND connection.active = true
         AND connection.status = 'VALID'
         AND ($3::text IS NULL OR dataset.dataset_id = $3)
       ORDER BY (dataset.dataset_id = $3) DESC, dataset.created_at
       LIMIT 1`,
      [lead.tenant_id, lead.meta_connection_id, lead.dataset_id || null],
    )
    : { rows: [] };
  const target = destination.rows[0] || null;
  if (!target) return null;
  const datasetKey = target?.meta_dataset_value || process.env.META_DATASET_ID || 'unset';
  const eventId = `crm:${lead.id}:${eventName.replaceAll(' ', '_').toLowerCase()}:${datasetKey}:${mode}`;
  const inserted = await client.query(
    `INSERT INTO meta_conversion_events (
       tenant_id, lead_id, event_name, event_id, event_time,
       meta_connection_id, meta_dataset_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [
      lead.tenant_id, lead.id, eventName, eventId, eventTime,
      target?.meta_connection_id || null,
      target?.meta_dataset_id || null,
    ],
  );
  if (inserted.rowCount === 1) return inserted.rows[0];
  const existing = await client.query(
    'SELECT * FROM meta_conversion_events WHERE event_id = $1 AND tenant_id = $2',
    [eventId, lead.tenant_id],
  );
  return existing.rows[0];
}

async function enqueueConversionJob(client, event) {
  if (event.status === 'SENT') return false;
  const result = await client.query(
    `INSERT INTO meta_jobs (tenant_id, job_type, dedupe_key, payload)
     VALUES ($1, 'CONVERSION', $2, $3)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [event.tenant_id, `conversion:${event.event_id}`, { eventId: event.id }],
  );
  if (result.rowCount === 1) return true;
  const requeued = await client.query(
    `UPDATE meta_jobs
     SET status = 'RETRY', attempts = 0, last_error = NULL,
         next_attempt_at = now(), locked_at = NULL, completed_at = NULL,
         updated_at = now()
     WHERE tenant_id = $1 AND dedupe_key = $2
       AND status IN ('FAILED', 'COMPLETED')
     RETURNING id`,
    [event.tenant_id, `conversion:${event.event_id}`],
  );
  if (!requeued.rowCount) return false;
  await client.query(
    `UPDATE meta_conversion_events
     SET status = 'RETRY', attempts = 0, last_error = NULL, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status <> 'SENT'`,
    [event.id, event.tenant_id],
  );
  return true;
}

async function ensureMetaEventForStage(
  client,
  { lead, stage, eventTime, mode, officialLabelEvidence = false },
) {
  const sequenceSkipped = ['NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].includes(stage);
  if (process.env.META_CAPI_OUTBOUND_ENABLED !== 'true') {
    return { event: null, jobCreated: false, reason: 'META_OUTBOUND_DISABLED', sequenceSkipped };
  }
  if (!lead.meta_lead_id) return { event: null, jobCreated: false, reason: 'META_LEAD_ID_MISSING', sequenceSkipped };
  if (!canCreateMetaForStage(stage, officialLabelEvidence)) {
    return {
      event: null,
      jobCreated: false,
      reason: 'OFFICIAL_WA2_LABEL_REQUIRED',
      sequenceSkipped,
    };
  }
  const eventNames = [getStageEventName(stage)].filter(Boolean);
  let primaryEvent = null;
  let jobCreated = false;
  for (const eventName of eventNames) {
    const event = await createOrGetMetaEvent(client, {
      lead,
      eventName,
      eventTime: eventTime || new Date(),
      mode,
    });
    if (!event) continue;
    primaryEvent ||= event;
    jobCreated = (await enqueueConversionJob(client, event)) || jobCreated;
  }
  return {
    event: primaryEvent,
    jobCreated,
    reason: primaryEvent ? null : 'META_DATASET_NOT_CONFIGURED',
    sequenceSkipped,
  };
}

async function enqueueWa2LabelJobs(
  client,
  { lead, previousStage, stageHistoryId },
) {
  if (!isWa2LabelStage(lead.stage)) {
    return { scheduled: 0, reason: 'STAGE_NOT_MAPPED' };
  }
  const candidates = await client.query(
    `SELECT link.id AS contact_link_id, link.wa2_instance_id,
            target.remote_label_id AS target_remote_label_id,
            previous.remote_label_id AS previous_remote_label_id
     FROM wa2_contact_links link
     JOIN wa2_instances instance
       ON instance.id = link.wa2_instance_id
      AND instance.tenant_id = link.tenant_id
      AND instance.enabled = true
     LEFT JOIN wa2_label_bindings target
       ON target.tenant_id = link.tenant_id
      AND target.wa2_instance_id = link.wa2_instance_id
      AND target.stage = $3
      AND target.enabled = true
     LEFT JOIN wa2_label_bindings previous
       ON previous.tenant_id = link.tenant_id
      AND previous.wa2_instance_id = link.wa2_instance_id
      AND previous.stage = $4
      AND previous.enabled = true
     WHERE link.tenant_id = $1
       AND link.lead_id = $2
       AND link.unlinked_at IS NULL
     FOR UPDATE OF link`,
    [lead.tenant_id, lead.id, lead.stage, previousStage],
  );
  if (candidates.rowCount === 0) {
    return { scheduled: 0, reason: 'NO_ACTIVE_LINK' };
  }
  const configured = candidates.rows.filter((row) => row.target_remote_label_id);
  if (configured.length === 0) {
    return { scheduled: 0, reason: 'NO_ENABLED_BINDING' };
  }
  let scheduled = 0;
  let unchanged = 0;
  for (const candidate of configured) {
    if (candidate.previous_remote_label_id === candidate.target_remote_label_id) {
      unchanged += 1;
      continue;
    }
    const inserted = await client.query(
      `INSERT INTO wa2_label_jobs (
         tenant_id, lead_id, wa2_instance_id, wa2_contact_link_id,
         stage_history_id, target_stage, target_remote_label_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (
         tenant_id, stage_history_id, wa2_instance_id, wa2_contact_link_id
       ) DO NOTHING
       RETURNING id`,
      [
        lead.tenant_id,
        lead.id,
        candidate.wa2_instance_id,
        candidate.contact_link_id,
        stageHistoryId,
        lead.stage,
        candidate.target_remote_label_id,
      ],
    );
    scheduled += inserted.rowCount;
  }
  return {
    scheduled,
    reason: scheduled > 0
      ? 'SCHEDULED'
      : unchanged === configured.length
        ? 'LABEL_UNCHANGED'
        : 'DUPLICATE',
  };
}

export async function moveLeadStage(id, stage, {
  origin = 'MANUAL',
  changedBy = null,
  observation = null,
  lostReason = null,
  lostNotes = null,
  metadata = {},
  mode = 'live',
} = {}) {
  if (!isValidHistoryOrigin(origin)) {
    throw new Error('Origem de histórico inválida');
  }
  if (isProtectedCommercialStage(stage) && !originMayConfirmProtectedStage(origin)) {
    throw new Error('Etapa protegida exige confirmação do sistema de origem');
  }
  if (isLossStage(stage) && !lostReason) {
    throw new Error('Motivo de perda obrigatório');
  }
  if (lostReason === 'OTHER' && !String(lostNotes || '').trim()) {
    throw new Error('Observação obrigatória para motivo Outro');
  }
  const eventName = getStageEventName(stage);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId()],
    );
    if (current.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const previousLead = current.rows[0];
    if (
      previousLead.stage === stage ||
      !canTransition(previousLead.stage, stage)
    ) {
      await client.query('ROLLBACK');
      return {
        lead: previousLead,
        invalidTransition: true,
        stageChanged: false,
        attributed: Boolean(previousLead.meta_lead_id),
      };
    }
    const timestampColumn = {
      CONTACT_STARTED: 'first_contact_at',
      IN_SERVICE: 'first_contact_at',
      QUALIFIED: 'qualified_at',
      OPPORTUNITY: 'opportunity_at',
      NEGOTIATING: 'opportunity_at',
      AWAITING_ENROLLMENT: 'opportunity_at',
      AWAITING_PAYMENT: 'opportunity_at',
      ENROLLED: 'matriculated_at',
      PAID: 'converted_at',
      LOST: 'lost_at',
      NO_INTEREST: 'lost_at',
      INVALID_PHONE: 'lost_at',
      DUPLICATED: 'lost_at',
    }[stage];
    const setTimestamp = timestampColumn
      ? `, ${timestampColumn} = COALESCE(${timestampColumn}, now())`
      : '';
    const updated = await client.query(
      `UPDATE leads SET stage = $2, updated_at = now() ${setTimestamp},
         lost_reason = CASE WHEN $4::boolean THEN $5 ELSE NULL END,
         lost_notes = CASE WHEN $4::boolean THEN $6 ELSE NULL END
       WHERE id = $1 AND tenant_id = $3 RETURNING *`,
      [id, stage, tenantId(), isLossStage(stage), lostReason, lostNotes],
    );
    const lead = updated.rows[0];
    const historyResult = await client.query(
      `INSERT INTO lead_stage_history (
         lead_id, tenant_id, previous_stage, new_stage, origin, changed_by,
         observation, activity_type, reason, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        id,
        lead.tenant_id,
        previousLead.stage,
        stage,
        origin,
        changedBy,
        observation,
        isLossStage(stage) ? 'LOST' : 'STAGE_CHANGED',
        lostReason,
        {
          ...metadata,
          ...(lostNotes ? { lostNotes: String(lostNotes).slice(0, 1000) } : {}),
        },
      ],
    );
    const wa2LabelSync = await enqueueWa2LabelJobs(client, {
      lead,
      previousStage: previousLead.stage,
      stageHistoryId: historyResult.rows[0].id,
    });

    let event = null;
    let jobCreated = false;
    let metaReason = null;
    let sequenceSkipped = false;
    if (eventName && lead.meta_lead_id) {
      ({ event, jobCreated, reason: metaReason, sequenceSkipped } = await ensureMetaEventForStage(client, {
        lead,
        stage,
        eventTime: timestampColumn ? lead[timestampColumn] : new Date(),
        mode,
      }));
      await client.query(
        `UPDATE lead_stage_history
         SET meta_event_id = $3,
             metadata = metadata || jsonb_build_object(
               'metaEventName', $4::text,
               'metaJobCreated', $5::boolean,
               'metaEvidence', $6::text,
               'metaSequenceSkipped', $7::boolean
             )
         WHERE tenant_id = $1 AND id = $2`,
        [
          lead.tenant_id,
          historyResult.rows[0].id,
          event?.id || null,
          eventName,
          jobCreated,
          event ? 'WA2_OFFICIAL_LABEL_CONFIRMED' : metaReason,
          sequenceSkipped,
        ],
      );
    }

    await client.query('COMMIT');
    return {
      lead,
      event,
      jobCreated,
      wa2LabelSync,
      stageChanged: true,
      attributed: Boolean(lead.meta_lead_id),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueLeadWa2Resync(id, actor = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), id],
    );
    const lead = selected.rows[0];
    if (!lead) {
      await client.query('ROLLBACK');
      return null;
    }
    const active = await client.query(
      `SELECT 1 FROM wa2_label_jobs
       WHERE tenant_id = $1 AND lead_id = $2 AND target_stage = $3
         AND status IN ('PENDING', 'RUNNING')
       LIMIT 1`,
      [tenantId(), id, lead.stage],
    );
    if (active.rows[0]) {
      await client.query('ROLLBACK');
      return { scheduled: 0, reason: 'DUPLICATE' };
    }
    const history = await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin, changed_by,
         observation, activity_type, metadata
       ) VALUES (
         $1,$2,$3,$3,'MANUAL',$4,'Sincronização WA2 solicitada em lote.',
         'LABEL_SYNC_REQUESTED', '{"bulk":true}'::jsonb
       )
       RETURNING id`,
      [tenantId(), id, lead.stage, safeActor(actor)],
    );
    const wa2LabelSync = await enqueueWa2LabelJobs(client, {
      lead,
      previousStage: null,
      stageHistoryId: history.rows[0].id,
    });
    await client.query('COMMIT');
    return wa2LabelSync;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueLeadgenJobs(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { accepted: 0, duplicates: 0 };
  }
  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const value = change.value || {};
      if (!/^\d{1,100}$/.test(String(value.leadgen_id || ''))) continue;
      jobs.push({
        metaLeadId: String(value.leadgen_id),
        receivedAt: new Date().toISOString(),
        webhookValue: {
          leadgen_id: String(value.leadgen_id),
          page_id: value.page_id ? String(value.page_id) : entry.id ? String(entry.id) : null,
          form_id: value.form_id ? String(value.form_id) : null,
          ad_id: value.ad_id ? String(value.ad_id) : null,
          created_time: value.created_time ?? null,
        },
      });
    }
  }

  if (jobs.length === 0) return { accepted: 0, duplicates: 0 };

  const client = await pool.connect();
  let accepted = 0;
  try {
    await client.query('BEGIN');
    for (const job of jobs) {
      const result = await client.query(
        `INSERT INTO meta_jobs (tenant_id, job_type, dedupe_key, payload)
         VALUES ($1, 'LEAD_IMPORT', $2, $3)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [tenantId(), `leadgen:${job.metaLeadId}`, job],
      );
      accepted += result.rowCount;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { accepted, duplicates: jobs.length - accepted };
}

export async function backfillMetaQualifiedEvents({ batchSize = 50, execute = false } = {}) {
  const limit = Math.max(1, Math.min(Number(batchSize) || 50, 500));
  const candidates = await pool.query(
    `SELECT lead.*
     FROM leads lead
     WHERE lead.tenant_id = $1
       AND lead.stage IN ('QUALIFIED', 'NEGOTIATING', 'OPPORTUNITY',
                          'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT')
       AND lead.meta_lead_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM meta_conversion_events event
         WHERE event.tenant_id = lead.tenant_id
           AND event.lead_id = lead.id
           AND event.event_name = 'Marketing Qualified Lead'
       )
       AND (
         SELECT count(*)
         FROM wa2_contact_links link
         JOIN wa2_instances instance
           ON instance.tenant_id = link.tenant_id
          AND instance.id = link.wa2_instance_id
          AND instance.enabled = true
         WHERE link.tenant_id = lead.tenant_id
           AND link.lead_id = lead.id
           AND link.unlinked_at IS NULL
       ) = 1
       AND EXISTS (
         SELECT 1
         FROM wa2_contact_links link
         JOIN wa2_instances instance
           ON instance.tenant_id = link.tenant_id
          AND instance.id = link.wa2_instance_id
          AND instance.enabled = true
         JOIN wa2_label_bindings binding
           ON binding.tenant_id = link.tenant_id
          AND binding.wa2_instance_id = link.wa2_instance_id
          AND binding.stage = lead.stage
          AND binding.enabled = true
         JOIN wa2_label_event_receipts receipt
           ON receipt.tenant_id = link.tenant_id
          AND receipt.remote_instance_id = instance.remote_instance_id
          AND receipt.remote_chat_id = link.remote_chat_id
          AND receipt.remote_label_id = binding.remote_label_id
          AND receipt.operation = 'APPLY'
         WHERE link.tenant_id = lead.tenant_id
           AND link.lead_id = lead.id
           AND link.unlinked_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM wa2_label_event_receipts removed
             WHERE removed.tenant_id = receipt.tenant_id
               AND removed.remote_instance_id = receipt.remote_instance_id
               AND removed.remote_chat_id = receipt.remote_chat_id
               AND removed.remote_label_id = receipt.remote_label_id
               AND removed.operation = 'REMOVE'
               AND removed.observed_at >= receipt.observed_at
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM wa2_contact_links other_link
         JOIN wa2_instances other_instance
           ON other_instance.tenant_id = other_link.tenant_id
          AND other_instance.id = other_link.wa2_instance_id
          AND other_instance.enabled = true
         JOIN wa2_label_bindings other_binding
           ON other_binding.tenant_id = other_link.tenant_id
          AND other_binding.wa2_instance_id = other_link.wa2_instance_id
          AND other_binding.enabled = true
         JOIN wa2_label_event_receipts other_receipt
           ON other_receipt.tenant_id = other_link.tenant_id
          AND other_receipt.remote_instance_id = other_instance.remote_instance_id
          AND other_receipt.remote_chat_id = other_link.remote_chat_id
          AND other_receipt.remote_label_id = other_binding.remote_label_id
          AND other_receipt.operation = 'APPLY'
         WHERE other_link.tenant_id = lead.tenant_id
           AND other_link.lead_id = lead.id
           AND other_link.unlinked_at IS NULL
           AND other_binding.remote_label_id <> (
             SELECT binding.remote_label_id
             FROM wa2_contact_links target_link
             JOIN wa2_label_bindings binding
               ON binding.tenant_id = target_link.tenant_id
              AND binding.wa2_instance_id = target_link.wa2_instance_id
              AND binding.stage = lead.stage
              AND binding.enabled = true
             WHERE target_link.tenant_id = lead.tenant_id
               AND target_link.lead_id = lead.id
               AND target_link.unlinked_at IS NULL
             LIMIT 1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM wa2_label_event_receipts other_removed
             WHERE other_removed.tenant_id = other_receipt.tenant_id
               AND other_removed.remote_instance_id = other_receipt.remote_instance_id
               AND other_removed.remote_chat_id = other_receipt.remote_chat_id
               AND other_removed.remote_label_id = other_receipt.remote_label_id
               AND other_removed.operation = 'REMOVE'
               AND other_removed.observed_at >= other_receipt.observed_at
           )
       )
     ORDER BY lead.updated_at, lead.id
     LIMIT $2`,
    [tenantId(), limit],
  );
  if (!execute || candidates.rowCount === 0) {
    return { selected: candidates.rows.length, created: 0, queued: 0, leads: candidates.rows };
  }
  const client = await pool.connect();
  let created = 0;
  let queued = 0;
  try {
    await client.query('BEGIN');
    for (const lead of candidates.rows) {
      const result = await ensureMetaEventForStage(client, {
        lead,
        stage: lead.stage,
        eventTime: lead.qualified_at || lead.updated_at,
        mode: process.env.META_TEST_MODE === 'true' ? 'test' : 'live',
        officialLabelEvidence: true,
      });
      if (result.event) created += 1;
      if (result.jobCreated) queued += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { selected: candidates.rows.length, created, queued, leads: candidates.rows };
}

export async function getDashboardCounts({ createdAfter = operationStartAt() } = {}) {
  const values = [tenantId()];
  const where = ['tenant_id = $1'];
  if (createdAfter) {
    values.push(createdAfter);
    where.push(`COALESCE(received_at, created_at) >= $${values.length}`);
  }
  const [result, queue] = await Promise.all([pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE stage = 'NEW')::int AS new,
      count(*) FILTER (WHERE stage = 'NEW' AND first_contact_at IS NULL)::int AS unattended,
      count(*) FILTER (WHERE stage = 'NO_RESPONSE')::int AS no_response,
      count(*) FILTER (WHERE stage = 'QUALIFIED')::int AS qualified,
      count(*) FILTER (WHERE stage IN ('CONTACT_STARTED', 'IN_SERVICE'))::int AS in_service,
      count(*) FILTER (
        WHERE stage IN (
          'OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'
        )
      )::int AS opportunities,
      count(*) FILTER (WHERE stage = 'AWAITING_ENROLLMENT')::int AS awaiting_enrollment,
      count(*) FILTER (WHERE stage = 'AWAITING_PAYMENT')::int AS awaiting_payment,
      count(*) FILTER (WHERE stage = 'ENROLLED')::int AS enrolled,
      count(*) FILTER (WHERE stage = 'PAID')::int AS paid,
      count(*) FILTER (
        WHERE stage IN ('LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED')
      )::int AS lost,
      count(*) FILTER (WHERE meta_lead_id IS NOT NULL)::int AS attributed
    FROM leads
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `, values), getQueueHealth()]);
  const counts = result.rows[0];
  const qualifiedJourney = counts.qualified + counts.opportunities + counts.enrolled + counts.paid;
  return {
    ...counts,
    qualificationRate: counts.total ? Math.round((qualifiedJourney / counts.total) * 1000) / 10 : 0,
    matriculationRate: counts.total ? Math.round((counts.enrolled / counts.total) * 1000) / 10 : 0,
    metaPending: queue.pending,
    metaRetry: queue.retry,
    metaFailed: queue.failed,
  };
}

export async function claimNextJob() {
  const result = await pool.query(`
    WITH candidate AS (
      SELECT id
      FROM meta_jobs
      WHERE tenant_id = $1 AND (job_type <> 'CONVERSION' OR $2 = 'true') AND ((
        status IN ('PENDING', 'RETRY')
        AND next_attempt_at <= now()
      ) OR (
        status = 'PROCESSING'
        AND locked_at < now() - interval '5 minutes'
      ))
      ORDER BY next_attempt_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE meta_jobs AS job
    SET status = 'PROCESSING',
        attempts = job.attempts + 1,
        locked_at = now(),
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  `, [tenantId(), process.env.META_CAPI_OUTBOUND_ENABLED || 'false']);
  return result.rows[0] ?? null;
}

export async function completeJob(id) {
  await pool.query(
    `UPDATE meta_jobs
     SET status = 'COMPLETED', last_error = NULL, locked_at = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId()],
  );
}

export async function failJob(id, error, { retryAt = null } = {}) {
  const status = retryAt ? 'RETRY' : 'FAILED';
  const result = await pool.query(
    `UPDATE meta_jobs
     SET status = $2, last_error = $3, next_attempt_at = COALESCE($4, next_attempt_at),
         locked_at = NULL, updated_at = now()
     WHERE id = $1 AND tenant_id = $5
     RETURNING *`,
    [id, status, String(error).slice(0, 2000), retryAt, tenantId()],
  );
  return result.rows[0];
}

export async function getMetaEventContext(id) {
  const result = await pool.query(
    `SELECT e.*, l.name, l.email, l.phone, l.phone_normalized, l.meta_lead_id,
            l.meta_connection_id AS lead_meta_connection_id,
            connection.encrypted_access_token, connection.status AS connection_status,
            connection.active AS connection_active,
            dataset.dataset_id, dataset.encrypted_test_event_code,
            dataset.active AS dataset_active
     FROM meta_conversion_events e
     JOIN leads l ON l.id = e.lead_id
     LEFT JOIN meta_connections connection
       ON connection.tenant_id = e.tenant_id
      AND connection.id = e.meta_connection_id
     LEFT JOIN meta_datasets dataset
       ON dataset.tenant_id = e.tenant_id
      AND dataset.id = e.meta_dataset_id
     WHERE e.id = $1 AND e.tenant_id = $2 AND l.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] ?? null;
}

export async function markMetaEventProcessing(id, attempts) {
  await pool.query(
    `UPDATE meta_conversion_events
     SET status = 'PROCESSING', attempts = $2, updated_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status <> 'SENT'`,
    [id, attempts, tenantId()],
  );
}

export async function markMetaEventSent(id, response, attempts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE meta_conversion_events
       SET status = 'SENT', attempts = $3, meta_response = $2,
           sent_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $4 AND status <> 'SENT'
       RETURNING tenant_id, lead_id, event_name`,
      [id, response, attempts, tenantId()],
    );
    if (updated.rows[0]) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, meta_event_id, metadata
         )
         SELECT event.tenant_id, event.lead_id, lead.stage, lead.stage, 'SYSTEM',
                'Evento Meta enviado ao dataset de origem.', 'META_EVENT_SENT',
                $1, jsonb_build_object('eventName', event.event_name)
         FROM (SELECT $2::text AS tenant_id, $3::uuid AS lead_id, $4::text AS event_name) event
         JOIN leads lead
           ON lead.tenant_id = event.tenant_id AND lead.id = event.lead_id`,
        [
          id,
          updated.rows[0].tenant_id,
          updated.rows[0].lead_id,
          updated.rows[0].event_name,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markMetaEventFailed(id, error, attempts, willRetry) {
  const safeError = String(error).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE meta_conversion_events
       SET status = $2, attempts = $3, last_error = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $5 AND status <> 'SENT'
       RETURNING tenant_id, lead_id, event_name`,
      [id, willRetry ? 'RETRY' : 'FAILED', attempts, safeError, tenantId()],
    );
    if (!willRetry && updated.rows[0]) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, meta_event_id, metadata
         )
         SELECT $2, $3, lead.stage, lead.stage, 'SYSTEM',
                'Falha terminal no envio do evento Meta.', 'META_EVENT_FAILED',
                $1, jsonb_build_object('eventName', $4::text)
         FROM leads lead
         WHERE lead.tenant_id = $2 AND lead.id = $3`,
        [
          id,
          updated.rows[0].tenant_id,
          updated.rows[0].lead_id,
          updated.rows[0].event_name,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (transactionError) {
    await client.query('ROLLBACK');
    throw transactionError;
  } finally {
    client.release();
  }
}

export async function listRecentMetaEvents(limit = 50) {
  const result = await pool.query(
    `SELECT e.*, l.name AS lead_name, l.meta_lead_id
     FROM meta_conversion_events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.tenant_id = $1 AND l.tenant_id = $1
     ORDER BY e.created_at DESC LIMIT $2`,
    [tenantId(), limit],
  );
  return result.rows;
}

export async function listRecentJobs(limit = 50) {
  const result = await pool.query(
    `SELECT j.id, j.job_type, j.status, j.attempts, j.last_error, j.next_attempt_at,
            j.completed_at, j.created_at, j.updated_at,
            COALESCE(j.payload->>'metaLeadId', l.meta_lead_id) AS meta_lead_id,
            e.event_name, e.event_id, l.name AS lead_name
     FROM meta_jobs j
     LEFT JOIN meta_conversion_events e
       ON e.id = CASE
         WHEN j.job_type = 'CONVERSION' THEN (j.payload->>'eventId')::uuid
         ELSE NULL
       END
     LEFT JOIN leads l ON l.id = e.lead_id
     WHERE j.tenant_id = $1
     ORDER BY j.created_at DESC LIMIT $2`,
    [tenantId(), limit],
  );
  return result.rows;
}

export async function retryFailedJob(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      'SELECT * FROM meta_jobs WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [id, tenantId()],
    );
    const job = selected.rows[0];
    if (!job || job.status !== 'FAILED') {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      `UPDATE meta_jobs
       SET status = 'RETRY', attempts = 0, last_error = NULL,
           next_attempt_at = now(), locked_at = NULL, completed_at = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
    if (job.job_type === 'CONVERSION' && job.payload?.eventId) {
      await client.query(
        `UPDATE meta_conversion_events
         SET status = 'RETRY', attempts = 0, last_error = NULL, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'FAILED'`,
        [job.payload.eventId, tenantId()],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextWa2LabelJob() {
  const result = await pool.query(
    `WITH terminal_stale AS (
       UPDATE wa2_label_jobs
       SET status = 'FAILED',
           locked_at = NULL,
           finished_at = now(),
           last_error_code = 'WA2_MAX_ATTEMPTS',
           last_error_message = 'Limite de tentativas atingido após recuperação.',
           updated_at = now()
       WHERE tenant_id = $1
         AND status = 'RUNNING'
         AND locked_at < now() - interval '5 minutes'
         AND attempts >= max_attempts
       RETURNING id
     ),
     candidate AS (
       SELECT id
       FROM wa2_label_jobs
       WHERE tenant_id = $1
         AND attempts < max_attempts
         AND (
           (status = 'PENDING' AND available_at <= now())
           OR (
             status = 'RUNNING'
             AND locked_at < now() - interval '5 minutes'
           )
         )
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE wa2_label_jobs AS job
     SET status = 'RUNNING',
         attempts = job.attempts + 1,
         locked_at = now(),
         finished_at = NULL,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.*`,
    [tenantId()],
  );
  return result.rows[0] || null;
}

export async function getWa2LabelJobContext(id) {
  const result = await pool.query(
    `SELECT job.*, instance.remote_instance_id, link.remote_chat_id,
            ARRAY(
              SELECT DISTINCT binding.remote_label_id
              FROM wa2_label_bindings binding
              WHERE binding.tenant_id = job.tenant_id
                AND binding.wa2_instance_id = job.wa2_instance_id
            ) AS known_remote_label_ids
     FROM wa2_label_jobs job
     JOIN wa2_instances instance
       ON instance.id = job.wa2_instance_id
      AND instance.tenant_id = job.tenant_id
      AND instance.enabled = true
     JOIN wa2_contact_links link
       ON link.id = job.wa2_contact_link_id
      AND link.tenant_id = job.tenant_id
      AND link.unlinked_at IS NULL
     JOIN wa2_label_bindings target
       ON target.tenant_id = job.tenant_id
      AND target.wa2_instance_id = job.wa2_instance_id
      AND target.stage = job.target_stage
      AND target.remote_label_id = job.target_remote_label_id
      AND target.enabled = true
     WHERE job.id = $1 AND job.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function completeWa2LabelJob(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE wa2_label_jobs
       SET status = 'DONE',
           locked_at = NULL,
           finished_at = now(),
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'
       RETURNING *`,
      [id, tenantId()],
    );
    const job = result.rows[0] || null;
    if (job) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, metadata
         )
         SELECT job.tenant_id, job.lead_id, lead.stage, lead.stage, 'SYSTEM',
                'Etiqueta comercial confirmada no WA2.', 'LABEL_APPLIED',
                jsonb_build_object(
                  'instanceId', job.wa2_instance_id::text,
                  'remoteLabelId', job.target_remote_label_id
                )
         FROM (
           SELECT $1::text AS tenant_id, $2::uuid AS lead_id,
                  $3::uuid AS wa2_instance_id, $4::text AS target_remote_label_id
         ) job
         JOIN leads lead
           ON lead.tenant_id = job.tenant_id AND lead.id = job.lead_id`,
        [
          job.tenant_id,
          job.lead_id,
          job.wa2_instance_id,
          job.target_remote_label_id,
        ],
      );
    }
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function requeueWa2LabelJobForRemoteConfirmation(
  id,
  { availableAt, pendingCode = 'WA2_REMOTE_PENDING' },
) {
  const result = await pool.query(
    `UPDATE wa2_label_jobs
     SET status = 'PENDING',
         available_at = $3,
         locked_at = NULL,
         finished_at = NULL,
         last_error_code = $4,
         last_error_message = NULL,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'
     RETURNING *`,
    [id, tenantId(), availableAt, pendingCode],
  );
  return result.rows[0] || null;
}

export async function failWa2LabelJob(id, error, { retryAt = null } = {}) {
  const status = retryAt ? 'PENDING' : 'FAILED';
  const result = await pool.query(
    `UPDATE wa2_label_jobs
     SET status = $3,
         available_at = COALESCE($4, available_at),
         locked_at = NULL,
         finished_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE NULL END,
         last_error_code = $5,
         last_error_message = $6,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'RUNNING'
     RETURNING *`,
    [id, tenantId(), status, retryAt, error.code, error.message],
  );
  return result.rows[0] || null;
}

export async function retryFailedWa2LabelJob(id) {
  const result = await pool.query(
    `UPDATE wa2_label_jobs
     SET status = 'PENDING',
         max_attempts = CASE
           WHEN attempts >= max_attempts THEN LEAST(10, attempts + 1)
           ELSE max_attempts
         END,
         available_at = now(),
         locked_at = NULL,
         finished_at = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         updated_at = now()
     WHERE id = $1
       AND tenant_id = $2
       AND status = 'FAILED'
       AND attempts < 10
     RETURNING *`,
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function listWa2LabelJobs(limit = 100) {
  const result = await pool.query(
    `SELECT job.*, lead.name AS lead_name, instance.name AS instance_name,
            instance.remote_instance_id,
            job.status = 'RUNNING'
              AND job.locked_at < now() - interval '5 minutes' AS stale
     FROM wa2_label_jobs job
     JOIN leads lead
       ON lead.id = job.lead_id AND lead.tenant_id = job.tenant_id
     JOIN wa2_instances instance
       ON instance.id = job.wa2_instance_id
      AND instance.tenant_id = job.tenant_id
     WHERE job.tenant_id = $1
     ORDER BY job.created_at DESC
     LIMIT $2`,
    [tenantId(), limit],
  );
  return result.rows;
}

export async function getWa2LabelJobCounts() {
  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
       count(*) FILTER (WHERE status = 'DONE')::int AS done,
       count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
       count(*) FILTER (
         WHERE status = 'RUNNING'
           AND locked_at < now() - interval '5 minutes'
       )::int AS stale
     FROM wa2_label_jobs
     WHERE tenant_id = $1`,
    [tenantId()],
  );
  return result.rows[0];
}

export async function getWa2LabelSyncStatusForLead(leadId, stage) {
  const result = await pool.query(
    `SELECT link.id AS contact_link_id, instance.id AS instance_id,
            instance.name AS instance_name,
            binding.id AS binding_id,
            binding.remote_label_id,
            binding.remote_label_name,
            binding.enabled AS binding_enabled,
            latest.id AS job_id,
            latest.status AS job_status,
            latest.attempts AS job_attempts,
            latest.available_at AS job_available_at,
            latest.finished_at AS job_finished_at,
            latest.last_error_code,
            latest.last_error_message
     FROM wa2_contact_links link
     JOIN wa2_instances instance
       ON instance.id = link.wa2_instance_id
      AND instance.tenant_id = link.tenant_id
     LEFT JOIN wa2_label_bindings binding
       ON binding.tenant_id = link.tenant_id
      AND binding.wa2_instance_id = link.wa2_instance_id
      AND binding.stage = $3
     LEFT JOIN LATERAL (
       SELECT job.*
       FROM wa2_label_jobs job
       WHERE job.tenant_id = link.tenant_id
         AND job.lead_id = link.lead_id
         AND job.wa2_instance_id = link.wa2_instance_id
       ORDER BY job.created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE link.tenant_id = $1
       AND link.lead_id = $2
       AND link.unlinked_at IS NULL
     ORDER BY instance.is_default DESC, instance.name NULLS LAST`,
    [tenantId(), leadId, stage],
  );
  return result.rows;
}

function safeActor(value) {
  const actor = String(value || '').trim();
  return actor ? actor.slice(0, 320) : null;
}

export async function claimWa2LabelEventCursor() {
  await pool.query(
    `INSERT INTO wa2_label_event_cursors (tenant_id)
     VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId()],
  );
  const result = await pool.query(
    `WITH candidate AS (
       SELECT tenant_id FROM wa2_label_event_cursors
       WHERE tenant_id = $1
         AND next_attempt_at <= now()
         AND (
           status IN ('IDLE', 'ERROR')
           OR (status = 'RUNNING' AND locked_at < now() - interval '5 minutes')
         )
       FOR UPDATE SKIP LOCKED
     )
     UPDATE wa2_label_event_cursors cursor
     SET status = 'RUNNING', locked_at = now(), updated_at = now()
     FROM candidate
     WHERE cursor.tenant_id = candidate.tenant_id
     RETURNING cursor.*`,
    [tenantId()],
  );
  return result.rows[0] || null;
}

export async function processWa2LabelEvent(event, currentRemoteLabelIds = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const receiptResult = await client.query(
      `INSERT INTO wa2_label_event_receipts (
         tenant_id, event_id, remote_instance_id, remote_chat_id, jid,
         phone_normalized, remote_label_id, remote_label_name, operation, source,
         eligible_for_crm, ineligible_reason, observed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id, event_id) DO NOTHING
       RETURNING *`,
      [
        tenantId(), event.eventId, event.instanceId, event.chatId, event.jid,
        event.phoneNormalized, event.waLabelId, event.waLabelName || null, event.operation, event.source,
        event.eligibleForCrm, event.ineligibleReason, event.observedAt,
      ],
    );
    if (receiptResult.rowCount === 0) {
      await client.query('COMMIT');
      return { duplicate: true, action: 'IGNORED', code: 'DUPLICATE_EVENT' };
    }
    const receipt = receiptResult.rows[0];
    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND remote_instance_id = $2 AND enabled = true`,
      [tenantId(), event.instanceId],
    );
    const instance = instanceResult.rows[0] || null;
    let link = null;
    let lead = null;
    if (instance) {
      const links = await client.query(
        `SELECT link.*, lead.stage, lead.meta_lead_id
         FROM wa2_contact_links link
         JOIN leads lead ON lead.tenant_id = link.tenant_id AND lead.id = link.lead_id
         WHERE link.tenant_id = $1 AND link.wa2_instance_id = $2
           AND link.remote_chat_id = $3 AND link.unlinked_at IS NULL
         FOR UPDATE OF link, lead`,
        [tenantId(), instance.id, event.chatId],
      );
      if (links.rowCount === 1) {
        link = links.rows[0];
        lead = { id: link.lead_id, stage: link.stage, meta_lead_id: link.meta_lead_id };
      }
    }

    let decision;
    let eventBindingStages = [];
    let currentCrmLabelStages = [];
    if (event.source === 'WHATSAPP' && event.operation === 'APPLY' && event.eligibleForCrm) {
      if (!instance) {
        decision = { action: 'CONFLICT', code: 'INSTANCE_NOT_CONFIGURED' };
      } else if (!lead) {
        const linkResolution = await client.query(
          `SELECT COUNT(DISTINCT candidate.id)::int AS lead_count,
                  COUNT(DISTINCT other_link.id)::int AS other_chat_link_count
           FROM leads candidate
           LEFT JOIN wa2_contact_links other_link
             ON other_link.tenant_id = candidate.tenant_id
            AND other_link.wa2_instance_id = $2
            AND other_link.lead_id = candidate.id
            AND other_link.unlinked_at IS NULL
            AND other_link.remote_chat_id <> $3
           WHERE candidate.tenant_id = $1
             AND candidate.phone_normalized = $4`,
          [tenantId(), instance.id, event.chatId, event.phoneNormalized],
        );
        const resolution = linkResolution.rows[0] || {};
        decision = {
          action: 'CONFLICT',
          code: classifyWa2LinkResolution({
            instanceConfigured: true,
            linkCount: links.rowCount,
            phoneNormalized: event.phoneNormalized,
            jid: event.jid,
            leadCount: Number(resolution.lead_count || 0),
            otherChatLinkCount: Number(resolution.other_chat_link_count || 0),
          }),
        };
      } else {
        const bindings = await client.query(
          `SELECT remote_label_id, array_agg(stage ORDER BY stage) AS stages
           FROM wa2_label_bindings
           WHERE tenant_id = $1 AND wa2_instance_id = $2 AND enabled = true
             AND remote_label_id = ANY($3::text[])
           GROUP BY remote_label_id`,
          [tenantId(), instance.id, [...new Set([event.waLabelId, ...currentRemoteLabelIds])]],
        );
        const byLabel = new Map(bindings.rows.map((row) => [row.remote_label_id, row.stages]));
        eventBindingStages = byLabel.get(event.waLabelId) || [];
        currentCrmLabelStages = currentRemoteLabelIds
          .map((id) => byLabel.get(id))
          .filter(Boolean);
      }
    }
    decision ||= decideInboundLabelAction({
      event,
      currentStage: lead?.stage,
      eventBindingStages,
      currentCrmLabelStages,
    });
    const actionResult = await client.query(
      `INSERT INTO wa2_inbound_label_actions (
         tenant_id, receipt_id, wa2_instance_id, wa2_contact_link_id,
         lead_id, target_stage, action, detail_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        tenantId(), receipt.id, instance?.id || null, link?.id || null,
        lead?.id || null, decision.targetStage || null, decision.action, decision.code,
      ],
    );
    const action = actionResult.rows[0];
    if (decision.action === 'CONFLICT') {
      await client.query(
        `INSERT INTO wa2_label_conflicts (
           tenant_id, action_id, lead_id, conflict_type, details
         ) VALUES ($1,$2,$3,$4,$5)`,
        [
          tenantId(), action.id, lead?.id || null, decision.code,
          { currentRemoteLabelIds, eventBindingStages },
        ],
      );
    } else if (decision.action === 'PENDING_CONFIRMATION') {
      await client.query(
        `INSERT INTO wa2_stage_confirmations (
           tenant_id, action_id, lead_id, wa2_contact_link_id, requested_stage
         ) VALUES ($1,$2,$3,$4,'ENROLLED')`,
        [tenantId(), action.id, lead.id, link.id],
      );
    } else if (decision.action === 'STAGE_CHANGED') {
      const timestampColumn = {
        CONTACT_STARTED: 'first_contact_at',
        IN_SERVICE: 'first_contact_at',
        QUALIFIED: 'qualified_at',
        OPPORTUNITY: 'opportunity_at',
        NEGOTIATING: 'opportunity_at',
        AWAITING_ENROLLMENT: 'opportunity_at',
        AWAITING_PAYMENT: 'opportunity_at',
        LOST: 'lost_at',
      }[decision.targetStage];
      const timestampUpdate = timestampColumn
        ? `, ${timestampColumn} = COALESCE(${timestampColumn}, $5)`
        : '';
      const updateValues = [tenantId(), lead.id, decision.targetStage, lead.stage];
      if (timestampColumn) updateValues.push(new Date(event.observedAt));
      const updated = await client.query(
        `UPDATE leads SET stage = $3, updated_at = now() ${timestampUpdate},
           lost_reason = CASE WHEN $3 = 'LOST' THEN 'OTHER' ELSE NULL END,
           lost_notes = CASE WHEN $3 = 'LOST'
             THEN 'Perda recebida por etiqueta WA2.' ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 AND stage = $4 RETURNING *`,
        updateValues,
      );
      if (updated.rowCount !== 1) throw new Error('Etapa do lead mudou durante o evento WA2');
      const history = await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin, observation,
           activity_type, reason
         ) VALUES (
           $1,$2,$3,$4,'WHATSAPP',$5,
           CASE WHEN $4 = 'LOST' THEN 'LOST' ELSE 'STAGE_CHANGED' END,
           CASE WHEN $4 = 'LOST' THEN 'OTHER' ELSE NULL END
         ) RETURNING id`,
        [
          tenantId(), lead.id, lead.stage, decision.targetStage,
          `Evento WA2 ${event.eventId}`,
        ],
      );
      await ensureMetaEventForStage(client, {
        lead: updated.rows[0],
        stage: decision.targetStage,
        eventTime: new Date(event.observedAt),
        mode: process.env.META_TEST_MODE === 'true' ? 'test' : 'live',
        officialLabelEvidence: Boolean(
          currentRemoteLabelIds.includes(event.waLabelId) &&
          currentCrmLabelStages.length <= 1,
        ),
      });
      void history;
    }
    await client.query('COMMIT');
    return { duplicate: false, action: decision.action, code: decision.code };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeWa2LabelEventPage(cursor, results) {
  const counts = results.reduce((total, result) => {
    if (result.action === 'CONFLICT') total.conflicts += 1;
    else if (result.action === 'PENDING_CONFIRMATION') total.pending += 1;
    else if (result.action === 'IGNORED') total.ignored += 1;
    else total.processed += 1;
    return total;
  }, { processed: 0, ignored: 0, conflicts: 0, pending: 0 });
  await pool.query(
    `UPDATE wa2_label_event_cursors
     SET cursor_value = COALESCE($2, cursor_value), status = 'IDLE',
         locked_at = NULL, next_attempt_at = now(),
         processed_count = processed_count + $3,
         ignored_count = ignored_count + $4,
         conflict_count = conflict_count + $5,
         pending_count = pending_count + $6,
         last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE tenant_id = $1 AND status = 'RUNNING'`,
    [tenantId(), cursor, counts.processed, counts.ignored, counts.conflicts, counts.pending],
  );
}

export async function failWa2LabelEventCursor(error, retryAt) {
  await pool.query(
    `UPDATE wa2_label_event_cursors
     SET status = 'ERROR', locked_at = NULL, next_attempt_at = $2,
         last_error_code = $3, last_error_message = $4, updated_at = now()
     WHERE tenant_id = $1`,
    [tenantId(), retryAt, error.code, error.message],
  );
}

export async function createMetaHistoricalImport({
  pageId = null,
  formId = null,
  formRecordIds = [],
  periodStart = null,
  periodEnd = null,
  actor,
}) {
  if (formRecordIds.length === 0) {
    const result = await pool.query(
      `INSERT INTO meta_historical_imports (tenant_id, page_id, form_id, started_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId(), pageId, formId, safeActor(actor)],
    );
    return [result.rows[0]];
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const forms = await client.query(
      `SELECT form_record.id, form_record.form_id, page.id AS page_record_id,
              page.page_id, connection.id AS connection_id
       FROM meta_forms form_record
       JOIN meta_pages page
         ON page.tenant_id = form_record.tenant_id
        AND page.id = form_record.meta_page_id
        AND page.active = true
       JOIN meta_connections connection
         ON connection.tenant_id = page.tenant_id
        AND connection.id = page.meta_connection_id
        AND connection.active = true
        AND connection.status = 'VALID'
       WHERE form_record.tenant_id = $1
         AND form_record.id = ANY($2::uuid[])
         AND form_record.active = true
       FOR UPDATE OF form_record`,
      [tenantId(), formRecordIds],
    );
    if (forms.rowCount !== formRecordIds.length) {
      throw new Error('Um ou mais formulários não pertencem ao tenant ou estão inativos');
    }
    const runs = [];
    for (const form of forms.rows) {
      const inserted = await client.query(
        `INSERT INTO meta_historical_imports (
           tenant_id, page_id, form_id, meta_connection_id,
           meta_page_record_id, meta_form_record_id, period_start,
           period_end, started_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          tenantId(), form.page_id, form.form_id, form.connection_id,
          form.page_record_id, form.id, periodStart, periodEnd, safeActor(actor),
        ],
      );
      if (lead) {
        await client.query(
          `INSERT INTO lead_stage_history (
             tenant_id, lead_id, previous_stage, new_stage, origin,
             observation, activity_type, metadata
           ) VALUES (
             $1,$2,$3,$3,'WHATSAPP','Conflito de etiqueta WA2 enviado para revisão.',
             'SYNC_CONFLICT',jsonb_build_object(
               'eventId', $4::text,
               'conflictType', $5::text,
               'instanceId', $6::text,
               'remoteLabelId', $7::text
             )
           )`,
          [
            tenantId(), lead.id, lead.stage, event.eventId, decision.code,
            instance?.id || null, event.waLabelId,
          ],
        );
      }
      runs.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
    return runs;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimMetaHistoricalImport() {
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id FROM meta_historical_imports
       WHERE tenant_id = $1
         AND (
           (status = 'PENDING' AND next_attempt_at <= now())
           OR (status = 'RUNNING' AND locked_at < now() - interval '5 minutes')
         )
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE meta_historical_imports run
     SET status = 'RUNNING', locked_at = now(),
         started_at = COALESCE(started_at, now()), updated_at = now()
     FROM candidate WHERE run.id = candidate.id RETURNING run.*`,
    [tenantId()],
  );
  return result.rows[0] || null;
}

export async function recordMetaHistoricalLead(importId, leadInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lead = await upsertLead(leadInput, { client });
    const item = await client.query(
      `INSERT INTO meta_historical_import_items (
         tenant_id, import_id, meta_lead_id, lead_id, result
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, import_id, meta_lead_id) DO NOTHING
       RETURNING id`,
      [
        tenantId(), importId, String(leadInput.metaLeadId), lead.id,
        lead.was_inserted ? 'CREATED' : 'UPDATED',
      ],
    );
    if (item.rowCount === 1) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, metadata
         ) VALUES (
           $1,$2,$3,$3,'META_WEBHOOK','Lead processado pela importação histórica.',
           'HISTORICAL_IMPORT', jsonb_build_object('importId', $4::text)
         )`,
        [tenantId(), lead.id, lead.stage, importId],
      );
      await client.query(
        `UPDATE meta_historical_imports
         SET received_count = received_count + 1,
             created_count = created_count + $3,
             updated_count = updated_count + $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), importId, lead.was_inserted ? 1 : 0, lead.was_inserted ? 0 : 1],
      );
    }
    await client.query('COMMIT');
    return lead;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function metaHistoricalImportIsActive(id) {
  const result = await pool.query(
    `SELECT status = 'RUNNING' AS active
     FROM meta_historical_imports WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), id],
  );
  return result.rows[0]?.active === true;
}

export async function recordMetaHistoricalInvalid(importId, metaLeadId, errorCode) {
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO meta_historical_import_items (
         tenant_id, import_id, meta_lead_id, result, error_code
       ) VALUES ($1,$2,$3,'INVALID',$4)
       ON CONFLICT (tenant_id, import_id, meta_lead_id) DO NOTHING RETURNING id
     )
     UPDATE meta_historical_imports
     SET received_count = received_count + (SELECT count(*) FROM inserted),
         invalid_count = invalid_count + (SELECT count(*) FROM inserted),
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), importId, String(metaLeadId).slice(0, 100), errorCode],
  );
  return result.rowCount;
}

export async function completeMetaHistoricalPage(id, { nextCursor, hasMore }) {
  await pool.query(
    `UPDATE meta_historical_imports
     SET cursor_value = $3, status = $4, locked_at = NULL,
         completed_at = CASE WHEN $4 = 'COMPLETED' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'`,
    [tenantId(), id, nextCursor, hasMore ? 'PENDING' : 'COMPLETED'],
  );
}

export async function pauseMetaHistoricalImport(id, error) {
  await pool.query(
    `UPDATE meta_historical_imports
     SET status = 'PAUSED', locked_at = NULL,
         last_error_code = $3, last_error_message = $4, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'`,
    [tenantId(), id, error.code, error.message],
  );
}

export async function setMetaHistoricalImportStatus(id, action) {
  const status = action === 'resume' ? 'PENDING' : 'CANCELLED';
  const allowed = action === 'resume'
    ? ['PAUSED', 'FAILED']
    : ['PENDING', 'PAUSED', 'RUNNING'];
  const result = await pool.query(
    `UPDATE meta_historical_imports
     SET status = $3, locked_at = NULL, next_attempt_at = now(),
         last_error_code = NULL, last_error_message = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND status = ANY($4::text[]) RETURNING *`,
    [tenantId(), id, status, allowed],
  );
  return result.rows[0] || null;
}

export async function createWa2Reconciliation({ instanceId, actor }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const instance = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2 AND enabled = true FOR UPDATE`,
      [tenantId(), instanceId],
    );
    if (!instance.rows[0]) throw new Wa2DataError('Instância inválida', 'WA2_INSTANCE_DISABLED');
    const run = await client.query(
      `INSERT INTO wa2_reconciliation_runs (
         tenant_id, wa2_instance_id, started_by
       ) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, wa2_instance_id)
         WHERE status IN ('PENDING', 'RUNNING')
       DO NOTHING
       RETURNING *`,
      [tenantId(), instanceId, safeActor(actor)],
    );
    if (!run.rows[0]) {
      throw new Wa2DataError(
        'Já existe uma reconciliação ativa para esta instância',
        'WA2_RECONCILIATION_ACTIVE',
      );
    }
    const items = await client.query(
      `INSERT INTO wa2_reconciliation_items (tenant_id, run_id, lead_id)
       SELECT tenant_id, $2, id FROM leads WHERE tenant_id = $1
       ON CONFLICT (tenant_id, run_id, lead_id) DO NOTHING`,
      [tenantId(), run.rows[0].id],
    );
    await client.query(
      `UPDATE wa2_reconciliation_runs SET total_count = $3
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), run.rows[0].id, items.rowCount],
    );
    await client.query('COMMIT');
    return { ...run.rows[0], total_count: items.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listWa2ReconciliationCandidatePhones() {
  const result = await pool.query(
    `SELECT DISTINCT phone
     FROM (
       SELECT NULLIF(BTRIM(phone_normalized), '') AS phone
       FROM leads WHERE tenant_id = $1
       UNION
       SELECT NULLIF(BTRIM(whatsapp_normalized), '') AS phone
       FROM leads WHERE tenant_id = $1
     ) candidates
     WHERE phone ~ '^55[1-9][0-9]{9,10}$'
     ORDER BY phone`,
    [tenantId()],
  );
  return result.rows.map((row) => row.phone);
}

export async function hasWa2ReconciliationRunToday() {
  const result = await pool.query(
    `SELECT (
       EXISTS (
         SELECT 1
         FROM scheduled_task_runs
         WHERE tenant_id = $1
           AND task_name = 'WA2_DAILY_RECONCILIATION'
           AND local_run_date =
             (now() AT TIME ZONE 'America/Sao_Paulo')::date
       )
       OR EXISTS (
         SELECT 1
         FROM wa2_reconciliation_runs
         WHERE tenant_id = $1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date =
             (now() AT TIME ZONE 'America/Sao_Paulo')::date
       )
     ) AS scheduled`,
    [tenantId()],
  );
  return result.rows[0]?.scheduled === true;
}

export async function enqueueDailyWa2Reconciliations(readyLocalInstanceIds) {
  if (!Array.isArray(readyLocalInstanceIds) || readyLocalInstanceIds.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const marker = await client.query(
      `INSERT INTO scheduled_task_runs (tenant_id, task_name, local_run_date)
       SELECT $1, 'WA2_DAILY_RECONCILIATION',
              (now() AT TIME ZONE 'America/Sao_Paulo')::date
       WHERE (now() AT TIME ZONE 'America/Sao_Paulo')::time >= time '00:01'
       ON CONFLICT DO NOTHING
       RETURNING local_run_date`,
      [tenantId()],
    );
    if (!marker.rows[0]) {
      await client.query('ROLLBACK');
      return 0;
    }
    const runs = await client.query(
      `INSERT INTO wa2_reconciliation_runs (
         tenant_id, wa2_instance_id, started_by
       )
       SELECT tenant_id, id, 'daily-schedule'
       FROM wa2_instances
       WHERE tenant_id = $1 AND enabled = true AND id = ANY($2::uuid[])
       ON CONFLICT (tenant_id, wa2_instance_id)
         WHERE status IN ('PENDING', 'RUNNING')
       DO NOTHING
       RETURNING id`,
      [tenantId()],
    );
    for (const run of runs.rows) {
      await client.query(
        `INSERT INTO wa2_reconciliation_items (tenant_id, run_id, lead_id)
         SELECT lead.tenant_id, $2, lead.id
         FROM leads lead
         WHERE lead.tenant_id = $1
           AND (
             NULLIF(BTRIM(COALESCE(lead.phone_normalized, '')), '') IS NOT NULL
             OR NULLIF(BTRIM(COALESCE(lead.whatsapp_normalized, '')), '') IS NOT NULL
             OR NULLIF(BTRIM(COALESCE(lead.phone, '')), '') IS NOT NULL
             OR NULLIF(BTRIM(COALESCE(lead.whatsapp, '')), '') IS NOT NULL
             OR LOWER(COALESCE(lead.remote_jid, '')) LIKE '%@s.whatsapp.net'
             OR LOWER(COALESCE(lead.remote_jid, '')) LIKE '%@c.us'
           )
         ON CONFLICT (tenant_id, run_id, lead_id) DO NOTHING`,
        [tenantId(), run.id],
      );
      await client.query(
        `UPDATE wa2_reconciliation_runs
         SET total_count = (
           SELECT count(*) FROM wa2_reconciliation_items
           WHERE tenant_id = $1 AND run_id = $2
         )
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), run.id],
      );
    }
    await client.query('COMMIT');
    return runs.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimWa2ReconciliationItem() {
  const result = await pool.query(
    `WITH candidate AS (
       SELECT item.id
       FROM wa2_reconciliation_items item
       JOIN wa2_reconciliation_runs run
         ON run.tenant_id = item.tenant_id AND run.id = item.run_id
       WHERE item.tenant_id = $1
         AND run.status IN ('PENDING', 'RUNNING')
         AND (
           item.status = 'PENDING'
           OR (item.status = 'RUNNING' AND item.locked_at < now() - interval '5 minutes')
         )
         AND item.attempts < 5
       ORDER BY item.created_at
       FOR UPDATE OF item SKIP LOCKED LIMIT 1
     )
     UPDATE wa2_reconciliation_items item
     SET status = 'RUNNING', attempts = attempts + 1,
         locked_at = now(), updated_at = now()
     FROM candidate
     WHERE item.id = candidate.id
     RETURNING item.*,
       (SELECT phone_normalized FROM leads
        WHERE id = item.lead_id AND tenant_id = item.tenant_id) AS phone_normalized,
       (SELECT whatsapp_normalized FROM leads
        WHERE id = item.lead_id AND tenant_id = item.tenant_id) AS whatsapp_normalized,
       (SELECT phone FROM leads
        WHERE id = item.lead_id AND tenant_id = item.tenant_id) AS phone,
       (SELECT whatsapp FROM leads
        WHERE id = item.lead_id AND tenant_id = item.tenant_id) AS whatsapp,
       (SELECT remote_jid FROM leads
        WHERE id = item.lead_id AND tenant_id = item.tenant_id) AS remote_jid,
       (SELECT remote_instance_id FROM wa2_instances
        WHERE id = (SELECT wa2_instance_id FROM wa2_reconciliation_runs
                    WHERE id = item.run_id AND tenant_id = item.tenant_id)
          AND tenant_id = item.tenant_id) AS remote_instance_id`,
    [tenantId()],
  );
  if (!result.rows[0]) return null;
  await pool.query(
    `UPDATE wa2_reconciliation_runs SET status = 'RUNNING',
       started_at = COALESCE(started_at, now()), locked_at = now(),
       heartbeat_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), result.rows[0].run_id],
  );
  return result.rows[0];
}

export async function completeWa2ReconciliationItem(
  item,
  { contact, chat, remoteLabelIds = [], resolution = 'EXACT', labeledCrm = false },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT item.*, lead.stage, lead.phone_normalized, run.wa2_instance_id
       FROM wa2_reconciliation_items item
       JOIN leads lead ON lead.tenant_id = item.tenant_id AND lead.id = item.lead_id
       JOIN wa2_reconciliation_runs run ON run.tenant_id = item.tenant_id AND run.id = item.run_id
       WHERE item.tenant_id = $1 AND item.id = $2 AND item.status = 'RUNNING'
       FOR UPDATE OF item, lead`,
      [tenantId(), item.id],
    );
    const row = locked.rows[0];
    if (!row) throw new Error('Item de reconciliação indisponível');
    const active = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND (lead_id = $3 OR remote_chat_id = $4) AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), row.wa2_instance_id, row.lead_id, chat.id],
    );
    const same = active.rows.find(
      (link) => link.lead_id === row.lead_id && link.remote_chat_id === chat.id,
    );
    if (active.rows.some((link) => link.id !== same?.id)) {
      await finishReconciliationItem(client, row, 'CONFLICT');
      await client.query('COMMIT');
      return 'CONFLICT';
    }
    let link = same;
    let baseResult = 'MATCHED';
    if (!link) {
      const inserted = await client.query(
        `INSERT INTO wa2_contact_links (
           tenant_id, lead_id, wa2_instance_id, remote_contact_id,
           remote_chat_id, jid, phone_normalized, linked_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'historical-reconciliation')
         RETURNING *`,
        [
          tenantId(), row.lead_id, row.wa2_instance_id, contact.id,
          chat.id, contact.jid, contact.phoneNormalized,
        ],
      );
      link = inserted.rows[0];
      baseResult = 'UPDATED';
    }
    const bindings = await client.query(
      `SELECT stage, remote_label_id FROM wa2_label_bindings
       WHERE tenant_id = $1 AND wa2_instance_id = $2 AND enabled = true`,
      [tenantId(), row.wa2_instance_id],
    );
    const currentBindings = bindings.rows.filter(
      (binding) => remoteLabelIds.includes(binding.remote_label_id),
    );
    const distinctLabels = [...new Set(currentBindings.map((binding) => binding.remote_label_id))];
    if (distinctLabels.length > 1) {
      await finishReconciliationItem(client, row, 'CONFLICT');
      await client.query('COMMIT');
      return 'CONFLICT';
    }
    if (distinctLabels.length === 1) {
      const decision = decideInboundLabelAction({
        event: { source: 'WHATSAPP', operation: 'APPLY', eligibleForCrm: true },
        currentStage: row.stage,
        eventBindingStages: currentBindings.map((binding) => binding.stage),
        currentCrmLabelStages: [currentBindings.map((binding) => binding.stage)],
      });
      if (decision.action === 'STAGE_CHANGED') {
        const timestampColumn = {
          CONTACT_STARTED: 'first_contact_at',
          IN_SERVICE: 'first_contact_at',
          QUALIFIED: 'qualified_at',
          OPPORTUNITY: 'opportunity_at',
          NEGOTIATING: 'opportunity_at',
          AWAITING_ENROLLMENT: 'opportunity_at',
          AWAITING_PAYMENT: 'opportunity_at',
          LOST: 'lost_at',
        }[decision.targetStage];
        const timestampUpdate = timestampColumn
          ? `, ${timestampColumn} = COALESCE(${timestampColumn}, now())`
          : '';
        const updated = await client.query(
          `UPDATE leads SET stage = $3, updated_at = now() ${timestampUpdate},
             lost_reason = CASE WHEN $3 = 'LOST' THEN 'OTHER' ELSE NULL END,
             lost_notes = CASE WHEN $3 = 'LOST'
               THEN 'Perda recebida na reconciliação WA2.' ELSE NULL END
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [tenantId(), row.lead_id, decision.targetStage],
        );
        await client.query(
          `INSERT INTO lead_stage_history (
             tenant_id, lead_id, previous_stage, new_stage, origin, observation,
             activity_type, reason
           ) VALUES (
             $1,$2,$3,$4,'WHATSAPP','Reconciliação histórica WA2',
             CASE WHEN $4 = 'LOST' THEN 'LOST' ELSE 'STAGE_CHANGED' END,
             CASE WHEN $4 = 'LOST' THEN 'OTHER' ELSE NULL END
           )`,
          [tenantId(), row.lead_id, row.stage, decision.targetStage],
        );
        await ensureMetaEventForStage(client, {
          lead: updated.rows[0],
          stage: decision.targetStage,
          eventTime: new Date(row.created_at || Date.now()),
          mode: process.env.META_TEST_MODE === 'true' ? 'test' : 'live',
          officialLabelEvidence: labeledCrm && distinctLabels.length === 1,
        });
      } else if (['CONFLICT', 'PENDING_CONFIRMATION'].includes(decision.action)) {
        await finishReconciliationItem(client, row, 'CONFLICT');
        await client.query('COMMIT');
        return 'CONFLICT';
      }
    } else {
      const target = bindings.rows.find((binding) => binding.stage === row.stage);
      if (target) {
        await client.query(
          `INSERT INTO wa2_label_jobs (
             tenant_id, lead_id, wa2_instance_id, wa2_contact_link_id,
             reconciliation_item_id, target_stage, target_remote_label_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, reconciliation_item_id)
             WHERE reconciliation_item_id IS NOT NULL DO NOTHING`,
          [
            tenantId(), row.lead_id, row.wa2_instance_id, link.id,
            row.id, row.stage, target.remote_label_id,
          ],
        );
        baseResult = 'UPDATED';
      } else {
        await finishReconciliationItem(client, row, 'LABEL_UNMAPPED');
        await client.query('COMMIT');
        return 'LABEL_UNMAPPED';
      }
    }
    const matchCode = labeledCrm
      ? `WA2_MATCH_LABELED_${resolution}`
      : `WA2_MATCH_${resolution}`;
    await finishReconciliationItem(client, row, baseResult, matchCode);
    await client.query('COMMIT');
    return baseResult;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finishReconciliationItem(client, item, result, matchCode = null) {
  await client.query(
    `UPDATE wa2_reconciliation_items
     SET status = 'DONE', result = $3, last_error_code = $4, locked_at = NULL,
         finished_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), item.id, result, matchCode],
  );
  await client.query(
    `UPDATE wa2_reconciliation_runs run
     SET processed_count = (
       SELECT count(*) FROM wa2_reconciliation_items
       WHERE tenant_id = run.tenant_id AND run_id = run.id
         AND status IN ('DONE', 'FAILED')
     ),
     status = CASE WHEN NOT EXISTS (
       SELECT 1 FROM wa2_reconciliation_items
       WHERE tenant_id = run.tenant_id AND run_id = run.id
         AND status IN ('PENDING', 'RUNNING')
     ) THEN CASE WHEN EXISTS (
       SELECT 1 FROM wa2_reconciliation_items
       WHERE tenant_id = run.tenant_id AND run_id = run.id
         AND (status = 'FAILED' OR result IN (
           'PHONE_EMPTY', 'PHONE_INVALID', 'NOT_FOUND_IN_WA2',
           'LID_UNRESOLVED', 'LABEL_UNMAPPED', 'CONFLICT', 'ERROR'
         ))
     ) THEN 'PARTIAL' ELSE 'COMPLETED' END ELSE 'RUNNING' END,
     heartbeat_at = now(),
     completed_at = CASE WHEN NOT EXISTS (
       SELECT 1 FROM wa2_reconciliation_items
       WHERE tenant_id = run.tenant_id AND run_id = run.id
         AND status IN ('PENDING', 'RUNNING')
     ) THEN now() ELSE NULL END,
     updated_at = now()
     WHERE run.tenant_id = $1 AND run.id = $2`,
    [tenantId(), item.run_id],
  );
}

export async function failWa2ReconciliationItem(item, result, errorCode, retry) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE wa2_reconciliation_items
       SET status = $3, result = CASE WHEN $3 = 'FAILED' THEN $4 ELSE NULL END,
           locked_at = NULL, last_error_code = $5,
           finished_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), item.id, retry ? 'PENDING' : 'FAILED', result, errorCode],
    );
    if (!retry) {
      await client.query(
        `UPDATE wa2_reconciliation_runs run
         SET processed_count = (
           SELECT count(*) FROM wa2_reconciliation_items
           WHERE tenant_id = run.tenant_id AND run_id = run.id
             AND status IN ('DONE', 'FAILED')
         ),
         status = CASE WHEN NOT EXISTS (
           SELECT 1 FROM wa2_reconciliation_items
           WHERE tenant_id = run.tenant_id AND run_id = run.id
             AND status IN ('PENDING', 'RUNNING')
         ) THEN 'PARTIAL' ELSE 'RUNNING' END,
         heartbeat_at = now(),
         completed_at = CASE WHEN NOT EXISTS (
           SELECT 1 FROM wa2_reconciliation_items
           WHERE tenant_id = run.tenant_id AND run_id = run.id
             AND status IN ('PENDING', 'RUNNING')
         ) THEN now() ELSE NULL END,
         updated_at = now()
         WHERE run.tenant_id = $1 AND run.id = $2`,
        [tenantId(), item.run_id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function retryWa2ReconciliationFailures(runId) {
  const result = await pool.query(
    `UPDATE wa2_reconciliation_items
     SET status = 'PENDING', result = NULL, locked_at = NULL,
         last_error_code = NULL, finished_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND run_id = $2
       AND status = 'FAILED' AND attempts < 5
       AND result NOT IN ('PHONE_EMPTY', 'PHONE_INVALID', 'LID_UNRESOLVED')
     RETURNING id`,
    [tenantId(), runId],
  );
  if (result.rowCount > 0) {
    await pool.query(
      `UPDATE wa2_reconciliation_runs
       SET status = 'PENDING', completed_at = NULL,
           retry_count = retry_count + 1,
           processed_count = (
             SELECT count(*) FROM wa2_reconciliation_items
             WHERE tenant_id = $1 AND run_id = $2
               AND status IN ('DONE', 'FAILED')
           ),
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), runId],
    );
  }
  return result.rowCount;
}

export async function listWa2ReconciliationItems({
  runId,
  result = null,
  limit = 100,
  offset = 0,
}) {
  const values = [tenantId(), runId];
  const resultFilter = result ? 'AND item.result = $3' : '';
  if (result) values.push(result);
  values.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  const limitIndex = values.length;
  values.push(Math.max(Number(offset) || 0, 0));
  const query = await pool.query(
    `SELECT item.*, lead.name AS lead_name, lead.phone, lead.phone_normalized,
            run.wa2_instance_id, instance.name AS instance_name
     FROM wa2_reconciliation_items item
     JOIN wa2_reconciliation_runs run
       ON run.tenant_id = item.tenant_id AND run.id = item.run_id
     JOIN leads lead
       ON lead.tenant_id = item.tenant_id AND lead.id = item.lead_id
     JOIN wa2_instances instance
       ON instance.tenant_id = run.tenant_id AND instance.id = run.wa2_instance_id
     WHERE item.tenant_id = $1 AND item.run_id = $2 ${resultFilter}
     ORDER BY item.created_at
     LIMIT $${limitIndex} OFFSET $${values.length}`,
    values,
  );
  return query.rows;
}

export async function decideWa2StageConfirmation(id, decision, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT confirmation.*, lead.stage, lead.meta_lead_id
       FROM wa2_stage_confirmations confirmation
       JOIN leads lead ON lead.tenant_id = confirmation.tenant_id
         AND lead.id = confirmation.lead_id
       WHERE confirmation.tenant_id = $1 AND confirmation.id = $2
         AND confirmation.status = 'PENDING'
       FOR UPDATE OF confirmation, lead`,
      [tenantId(), id],
    );
    const confirmation = selected.rows[0];
    if (!confirmation) {
      await client.query('ROLLBACK');
      return null;
    }
    if (decision === 'reject') {
      await client.query(
        `UPDATE wa2_stage_confirmations
         SET status = 'REJECTED', confirmed_at = now(), confirmed_by = $3
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), id, safeActor(actor)],
      );
      await client.query('COMMIT');
      return { status: 'REJECTED' };
    }
    throw new Error(
      'Matrícula não pode ser confirmada manualmente; aguarde o sistema de origem',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listHistoricalOperations() {
  const [cursor, imports, fileImports, reconciliations, conflicts, confirmations] = await Promise.all([
    pool.query('SELECT * FROM wa2_label_event_cursors WHERE tenant_id = $1', [tenantId()]),
    pool.query(
      `SELECT * FROM meta_historical_imports
       WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [tenantId()],
    ),
    pool.query(
      `SELECT * FROM lead_file_imports
       WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [tenantId()],
    ),
    pool.query(
      `SELECT run.*, instance.name AS instance_name,
              (SELECT jsonb_object_agg(result, count) FROM (
                SELECT result, count(*)::int AS count
                FROM wa2_reconciliation_items item
                WHERE item.tenant_id = run.tenant_id AND item.run_id = run.id
                  AND result IS NOT NULL GROUP BY result
              ) totals) AS results
       FROM wa2_reconciliation_runs run
       JOIN wa2_instances instance
         ON instance.tenant_id = run.tenant_id AND instance.id = run.wa2_instance_id
       WHERE run.tenant_id = $1 ORDER BY run.created_at DESC LIMIT 20`,
      [tenantId()],
    ),
    pool.query(
      `SELECT conflict.*, lead.name AS lead_name
       FROM wa2_label_conflicts conflict
       LEFT JOIN leads lead ON lead.tenant_id = conflict.tenant_id
         AND lead.id = conflict.lead_id
       WHERE conflict.tenant_id = $1 AND conflict.status = 'OPEN'
       ORDER BY conflict.created_at DESC LIMIT 50`,
      [tenantId()],
    ),
    pool.query(
      `SELECT confirmation.*, lead.name AS lead_name
       FROM wa2_stage_confirmations confirmation
       JOIN leads lead ON lead.tenant_id = confirmation.tenant_id
         AND lead.id = confirmation.lead_id
       WHERE confirmation.tenant_id = $1 AND confirmation.status = 'PENDING'
       ORDER BY confirmation.created_at DESC LIMIT 50`,
      [tenantId()],
    ),
  ]);
  return {
    cursor: cursor.rows[0] || null,
    imports: imports.rows,
    fileImports: fileImports.rows,
    reconciliations: reconciliations.rows,
    conflicts: conflicts.rows,
    confirmations: confirmations.rows,
  };
}

export async function recordWorkerHeartbeat({ started = false } = {}) {
  await pool.query(
    `INSERT INTO worker_heartbeats (worker_name)
     VALUES ($1)
     ON CONFLICT (worker_name) DO UPDATE
       SET heartbeat_at = now(),
           started_at = CASE WHEN $2 THEN now() ELSE worker_heartbeats.started_at END`,
    [WORKER_NAME, started],
  );
}

export async function getQueueHealth() {
  const result = await pool.query(`
    SELECT
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
      count(*) FILTER (WHERE status = 'RETRY')::int AS retry,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed
    FROM meta_jobs WHERE tenant_id = $1
  `, [tenantId()]);
  return result.rows[0];
}

export async function getWorkerHealth() {
  const result = await pool.query(
    `SELECT heartbeat_at, started_at,
            heartbeat_at >= now() - interval '45 seconds' AS healthy
     FROM worker_heartbeats WHERE worker_name = $1`,
    [WORKER_NAME],
  );
  const heartbeat = result.rows[0];
  return {
    healthy: heartbeat?.healthy === true,
    heartbeatAt: heartbeat?.heartbeat_at || null,
    startedAt: heartbeat?.started_at || null,
  };
}

export async function closePool() {
  await pool.end();
}
