import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  canTransition,
  getStageEventName,
  isLossStage,
  isProtectedCommercialStage,
  isValidHistoryOrigin,
  isKnownStage,
  originMayConfirmProtectedStage,
} from './funnel.js';
import {
  getBrazilianPhoneIdentity,
  normalizeConfirmedWhatsAppPhone,
  normalizeWhatsAppPhone,
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
  canonicalInboundStage,
  classifyWa2LinkResolution,
  decideInboundLabelAction,
  officialCrmLabelStageFor,
  isInternalTestLead,
} from './historical-sync.js';
import {
  WA2_CHAT_REBIND_ACTIVITY,
  WA2_CHAT_REBIND_REASON,
  WA2_CURRENT_LABEL_CONFIRMATION_ACTIVITY,
  WA2_NORMAL_CHAT_REBIND_REASON,
  createNormalRebindHistoryMetadata,
  createRebindHistoryMetadata,
  normalRebindPayloadHash,
  rebindPayloadHash,
  sameAliasSet,
  validateCurrentLabelEvidence,
  validateRebindAdapterEvidence,
} from './wa2-rebind.js';
import {
  MANUAL_STAGE_REQUEST_STATUSES,
  MQL_VALIDITY,
  STAGE_SOURCES,
  STAGE_VERIFICATION_STATUSES,
  classifyMqlEvidence,
  canonicalStageForBindingStages,
  isMetaOutboundEligibleByStageTruth,
  MQL_AUDIT_CLASSES,
} from './stage-truth.js';
import {
  META_CLEAN_DATASET_ID,
  META_LEGACY_DATASET_ID,
} from './meta-clean-config.js';

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
  return `WITH current_wa2_labels AS MATERIALIZED (
    SELECT DISTINCT ON (
      receipt.tenant_id, link.wa2_instance_id, receipt.remote_chat_id, receipt.remote_label_id
    )
      receipt.tenant_id,
      link.lead_id,
      link.wa2_instance_id,
      instance.name AS instance_name,
      instance.remote_instance_id,
      receipt.remote_chat_id,
      receipt.id AS receipt_id,
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
  review,
  excludeInternalTests = false,
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
    where.push('leads.is_internal_test = false');
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
  if (excludeInternalTests) where.push('leads.is_internal_test = false');
  if (review === 'PHONE_INVALID_OR_MISSING') {
    where.push("(leads.import_phone_status IN ('PHONE_INVALID', 'PHONE_MISSING') OR COALESCE(leads.phone_normalized, leads.whatsapp_normalized) IS NULL)");
  }
  if (review === 'POSSIBLE_PHONE_DUPLICATE') where.push("leads.import_phone_status = 'POSSIBLE_PHONE_DUPLICATE'");
  if (review === 'MULTIPLE_ACTIVE_WA_LINKS') {
    where.push(`(SELECT count(*) FROM wa2_contact_links review_link
      WHERE review_link.tenant_id = leads.tenant_id AND review_link.lead_id = leads.id
        AND review_link.unlinked_at IS NULL) > 1`);
  }
  if (review === 'PENDING_IDENTITY') {
    where.push("leads.stage_verification_status IN ('PENDING_WA_LABEL', 'UNVERIFIED_LEGACY')");
  }
  if (review === 'AWAITING_MANUAL_RECLASSIFICATION') where.push('leads.awaiting_manual_reclassification = true');
  if (review === 'READY_FOR_FIRST_LINK') {
    where.push('leads.awaiting_manual_reclassification = true');
    where.push("COALESCE(leads.import_phone_status, '') NOT IN ('PHONE_INVALID', 'PHONE_MISSING', 'POSSIBLE_PHONE_DUPLICATE')");
    where.push('COALESCE(leads.phone_normalized, leads.whatsapp_normalized) IS NOT NULL');
    where.push(`NOT EXISTS (SELECT 1 FROM wa2_contact_links ready_link
      WHERE ready_link.tenant_id = leads.tenant_id AND ready_link.lead_id = leads.id
        AND ready_link.unlinked_at IS NULL)`);
  }
  if (review === 'ROUTING_PENDING') where.push("leads.routing_source = 'ROUTING_PENDING'");
  if (review === 'MQL_ALREADY_VALID') {
    where.push(`EXISTS (SELECT 1 FROM meta_conversion_events review_event
      WHERE review_event.tenant_id = leads.tenant_id AND review_event.lead_id = leads.id
        AND review_event.event_name = 'Marketing Qualified Lead'
        AND review_event.validity_status = 'VALID')`);
  }

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
       , meta_status.mql_status, meta_status.mql_validity, meta_status.opportunity_status
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
            AND event.validity_status = 'VALID'
            AND event.event_id = concat('crm:', leads.id, ':marketing_qualified_lead:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_status,
         (SELECT event.validity_status FROM meta_conversion_events event
          WHERE event.tenant_id = leads.tenant_id AND event.lead_id = leads.id
            AND event.event_name = 'Marketing Qualified Lead'
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_validity,
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id = leads.tenant_id AND event.lead_id = leads.id
            AND event.validity_status = 'VALID'
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
       internal_test.flag AS internal_test_flag,
       internal_test.reason AS internal_test_reason,
       internal_test.marked_at AS internal_test_marked_at,
       internal_test.marked_by AS internal_test_marked_by,
       instance.name AS wa2_instance_name,
       labels.labels AS wa2_labels, labels.last_sync_at AS wa2_labels_synced_at,
       meta_status.mql_status, meta_status.mql_validity, meta_status.opportunity_status
     FROM leads
     LEFT JOIN lead_internal_test_flags internal_test
       ON internal_test.tenant_id = leads.tenant_id AND internal_test.lead_id = leads.id
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
            AND event.validity_status = 'VALID'
            AND event.event_id = concat('crm:', leads.id, ':marketing_qualified_lead:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_status,
         (SELECT event.validity_status FROM meta_conversion_events event
          WHERE event.tenant_id=leads.tenant_id AND event.lead_id=leads.id
            AND event.event_name = 'Marketing Qualified Lead'
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS mql_validity,
         (SELECT event.status FROM meta_conversion_events event
          WHERE event.tenant_id=leads.tenant_id AND event.lead_id=leads.id
            AND event.validity_status = 'VALID'
            AND event.event_id = concat('crm:', leads.id, ':sales_opportunity:', '${currentMetaMode}')
          ORDER BY event.updated_at DESC, event.created_at DESC LIMIT 1) AS opportunity_status
     ) meta_status ON true
     WHERE leads.id = $2 AND leads.tenant_id = $3`,
    [tenantId(), id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function markLeadInternalTest({
  leadId,
  metaLeadId,
  reason,
  confirmation,
  actor,
}) {
  if (confirmation !== 'MARK_INTERNAL_TEST') throw new Error('INTERNAL_TEST_CONFIRMATION_REQUIRED');
  const safeReason = String(reason || '').trim().slice(0, 200);
  if (safeReason.length < 5) throw new Error('INTERNAL_TEST_REASON_REQUIRED');
  const safeMetaLeadId = String(metaLeadId || '').trim();
  if (!safeMetaLeadId) throw new Error('META_LEAD_ID_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM leads
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = selected.rows[0];
    if (!lead) throw new Error('LEAD_NOT_FOUND');
    if (!lead.meta_lead_id || String(lead.meta_lead_id) !== safeMetaLeadId) {
      throw new Error('META_LEAD_ID_MISMATCH');
    }
    const flag = await client.query(
      `INSERT INTO lead_internal_test_flags (
         tenant_id, lead_id, reason, marked_by, metadata
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, lead_id) DO UPDATE SET
         reason = EXCLUDED.reason,
         marked_by = EXCLUDED.marked_by,
         metadata = lead_internal_test_flags.metadata || EXCLUDED.metadata
       RETURNING *`,
      [
        lead.tenant_id,
        lead.id,
        safeReason,
        String(actor || 'admin').slice(0, 320),
        { confirmation, metaLeadId: safeMetaLeadId },
      ],
    );
    const updated = await client.query(
      `UPDATE leads
       SET is_internal_test = true,
           meta_outbound_eligible = false,
           updated_at = now()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [lead.tenant_id, lead.id],
    );
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'SYSTEM',$4,'META_EVENT_BLOCKED_INTERNAL_TEST',$5)`,
      [
        lead.tenant_id,
        lead.id,
        lead.stage,
        `Lead marcado como INTERNAL_TEST: ${safeReason}`,
        { flag: 'INTERNAL_TEST', reason: safeReason, markedBy: String(actor || 'admin').slice(0, 320) },
      ],
    );
    await client.query('COMMIT');
    return { lead: updated.rows[0], flag: flag.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
          WHEN NULLIF(BTRIM(leads.phone), '') IS NULL THEN EXCLUDED.phone
          ELSE leads.phone
        END,
        phone_normalized = COALESCE(leads.phone_normalized, EXCLUDED.phone_normalized),
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
        raw_meta = COALESCE(leads.raw_meta, '{}'::jsonb) || COALESCE(EXCLUDED.raw_meta, '{}'::jsonb),
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

const OWNER_CONFIRMED_SPREADSHEET_SOURCE = 'SPREADSHEET_IMPORT_2026';

export async function importSpreadsheetLeads({
  parsedFile,
  actor = 'admin:spreadsheet-import',
  businessId,
  datasetId,
  connectionName,
  allowlist,
}) {
  if (!parsedFile?.rows?.length) throw new Error('SPREADSHEET_EMPTY');
  const currentTenantId = tenantId();
  const safeActorValue = safeActor(actor) || 'admin:spreadsheet-import';
  const rows = parsedFile.rows;
  const metaLeadIds = rows.map((row) => row.metaLeadId).filter(Boolean);
  if (new Set(metaLeadIds).size !== rows.length) throw new Error('DUPLICATE_META_LEAD_ID');
  const routing = allowlist || {};
  for (const row of rows) {
    const route = routing[String(row.metaFormId || '')];
    if (!route) throw new Error(`FORM_NOT_ALLOWLISTED:${row.metaFormId || 'missing'}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingImport = await client.query(
      `SELECT * FROM lead_file_imports
       WHERE tenant_id = $1 AND sha256 = $2 AND sheet_name = 'ALL_SHEETS'
         AND status IN ('PREVIEW', 'PROCESSING', 'COMPLETED')
       FOR UPDATE`,
      [currentTenantId, parsedFile.sha256],
    );
    if (existingImport.rows[0]) {
      await client.query('COMMIT');
      return { idempotent: true, import: existingImport.rows[0] };
    }

    const connectionResult = await client.query(
      `SELECT connection.id
       FROM meta_connections connection
       JOIN meta_datasets dataset
         ON dataset.tenant_id = connection.tenant_id
        AND dataset.meta_connection_id = connection.id
       WHERE connection.tenant_id = $1
         AND connection.name = $2
         AND connection.business_id = $3
         AND connection.active = true
         AND connection.status = 'VALID'
         AND dataset.dataset_id = $4
         AND dataset.active = true
       ORDER BY connection.created_at
       LIMIT 2`,
      [currentTenantId, connectionName, String(businessId), String(datasetId)],
    );
    if (connectionResult.rowCount !== 1) throw new Error('ROUTING_CONNECTION_NOT_UNIQUE');
    const connectionId = connectionResult.rows[0].id;

    const existingResult = await client.query(
      `SELECT id, meta_lead_id, phone_normalized, whatsapp_normalized
       FROM leads
       WHERE tenant_id = $1 AND meta_lead_id = ANY($2::text[])
       FOR UPDATE`,
      [currentTenantId, metaLeadIds],
    );
    const existingByMeta = new Map(existingResult.rows.map((row) => [row.meta_lead_id, row]));
    const validPhones = rows.map((row) => row.phoneNormalized).filter(Boolean);
    const existingPhoneResult = validPhones.length
      ? await client.query(
        `SELECT id, meta_lead_id, phone_normalized, whatsapp_normalized
         FROM leads
         WHERE tenant_id = $1
           AND (phone_normalized = ANY($2::text[]) OR whatsapp_normalized = ANY($2::text[]))
         FOR UPDATE`,
        [currentTenantId, [...new Set(validPhones)]],
      )
      : { rows: [] };
    const phoneGroups = new Map();
    for (const row of rows) {
      if (row.phoneNormalized) phoneGroups.set(
        row.phoneNormalized,
        (phoneGroups.get(row.phoneNormalized) || 0) + 1,
      );
    }
    const existingByPhone = new Map();
    for (const row of existingPhoneResult.rows) {
      const phone = row.phone_normalized || row.whatsapp_normalized;
      if (phone) {
        const bucket = existingByPhone.get(phone) || [];
        bucket.push(row);
        existingByPhone.set(phone, bucket);
      }
    }
    const classifications = rows.map((row) => {
      const existing = existingByMeta.get(row.metaLeadId) || null;
      const otherExistingPhone = (existingByPhone.get(row.phoneNormalized) || [])
        .some((candidate) => candidate.meta_lead_id !== row.metaLeadId);
      const possibleDuplicate = Boolean(
        row.phoneNormalized && ((phoneGroups.get(row.phoneNormalized) || 0) > 1 || otherExistingPhone),
      );
      const phoneStatus = row.errors.includes('PHONE_MISSING')
        ? 'PHONE_MISSING'
        : row.errors.includes('PHONE_INVALID')
          ? 'PHONE_INVALID'
          : possibleDuplicate ? 'POSSIBLE_PHONE_DUPLICATE' : null;
      return { row, existing, decision: existing ? 'UPDATE' : 'NEW', possibleDuplicate, phoneStatus };
    });
    const counts = classifications.reduce((summary, item) => {
      summary.total += 1;
      summary[item.decision === 'NEW' ? 'new' : 'update'] += 1;
      if (item.possibleDuplicate) summary.possibleDuplicate += 1;
      if (item.phoneStatus === 'PHONE_MISSING' || item.phoneStatus === 'PHONE_INVALID') summary.invalid += 1;
      return summary;
    }, { total: 0, new: 0, update: 0, possibleDuplicate: 0, invalid: 0 });
    const importResult = await client.query(
      `INSERT INTO lead_file_imports (
         tenant_id, status, original_filename, sha256, format, sheet_name,
         total_count, new_count, update_count, possible_duplicate_count,
         invalid_count, created_by, summary, confirmed_at
       ) VALUES ($1,'PROCESSING',$2,$3,$4,'ALL_SHEETS',$5,$6,$7,$8,$9,$10,$11,now())
       RETURNING *`,
      [
        currentTenantId, parsedFile.filename, parsedFile.sha256, parsedFile.format,
        counts.total, counts.new, counts.update, counts.possibleDuplicate, counts.invalid,
        safeActorValue, serializeJsonb({ ...counts, source: OWNER_CONFIRMED_SPREADSHEET_SOURCE }, {}),
      ],
    );
    const importId = importResult.rows[0].id;
    const appliedLeads = [];
    for (let index = 0; index < classifications.length; index += 1) {
      const { row, decision, phoneStatus } = classifications[index];
      const route = routing[String(row.metaFormId)];
      const rawMeta = { ...(row.rawMeta || {}), _sheet_name: row.sheetName || '' };
      const itemResult = await client.query(
        `INSERT INTO lead_file_import_items (
           tenant_id, import_id, row_number, meta_lead_id, name, phone,
           phone_normalized, meta_created_at, meta_ad_id, meta_adset_id,
           meta_campaign_id, meta_form_id, raw_meta, decision, errors,
           existing_lead_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          currentTenantId, importId, index + 2, row.metaLeadId, row.name || null,
          row.phone || null, row.phoneNormalized || null, row.metaCreatedAt || null,
          row.metaAdId, row.metaAdsetId, row.metaCampaignId, row.metaFormId,
          serializeJsonb(rawMeta, {}), decision,
          serializeJsonb([...new Set([...(row.errors || []), ...(phoneStatus ? [phoneStatus] : []),
            ...(classifications[index].possibleDuplicate ? ['POSSIBLE_PHONE_DUPLICATE'] : [])])], []),
          classifications[index].existing?.id || null,
        ],
      );
      const lead = await upsertLead({
        tenantId: currentTenantId,
        name: row.name || 'Lead Meta',
        email: row.email,
        phone: row.phone || null,
        phoneNormalized: row.phoneNormalized,
        course: row.course,
        city: row.city,
        source: 'META_INSTANT_FORM',
        stage: 'NEW',
        metaLeadId: row.metaLeadId,
        metaPageId: route.pageId || null,
        metaFormId: row.metaFormId,
        metaAdId: row.metaAdId,
        metaAdsetId: row.metaAdsetId,
        metaCampaignId: row.metaCampaignId,
        metaCreatedAt: row.metaCreatedAt,
        sourceCreatedAt: row.metaCreatedAt,
        rawMeta,
        metaConnectionId: connectionId,
        businessId: String(businessId),
        datasetId: String(datasetId),
      }, { client });
      appliedLeads.push(lead.id);
      await client.query(
        `UPDATE lead_file_import_items
         SET applied_lead_id = $3, applied_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [currentTenantId, itemResult.rows[0].id, lead.id],
      );
    }

    const armedAt = new Date();
    for (let index = 0; index < classifications.length; index += 1) {
      const { row, phoneStatus } = classifications[index];
      const route = routing[String(row.metaFormId)];
      const leadId = appliedLeads[index];
      await client.query(
        `UPDATE leads
         SET awaiting_manual_reclassification = true,
             reclassification_armed_at = $3,
             reclassification_source = $4,
             routing_source = $5,
             import_phone_status = $6,
             updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [currentTenantId, leadId, armedAt, OWNER_CONFIRMED_SPREADSHEET_SOURCE,
          route.routingSource || 'OWNER_CONFIRMED_FORM_MAPPING', phoneStatus],
      );
      await client.query(
        `INSERT INTO lead_reclassification_audits (
           tenant_id, lead_id, import_id, armed_at, source, marked_by, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, lead_id, import_id) DO NOTHING`,
        [currentTenantId, leadId, importId, armedAt, OWNER_CONFIRMED_SPREADSHEET_SOURCE,
          safeActorValue, { metaLeadId: classifications[index].row.metaLeadId }],
      );
    }
    const summary = {
      ...counts,
      applied: appliedLeads.length,
      armedAt: armedAt.toISOString(),
      routingSource: 'OWNER_CONFIRMED_FORM_MAPPING',
      graphPosts: 0,
      metaEvents: 0,
      metaJobs: 0,
    };
    const completed = await client.query(
      `UPDATE lead_file_imports
       SET status = 'COMPLETED', applied_count = $3, completed_at = $4,
           summary = $5
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [currentTenantId, importId, appliedLeads.length, armedAt, serializeJsonb(summary, {})],
    );
    await client.query('COMMIT');
    return {
      idempotent: false,
      import: completed.rows[0],
      counts: summary,
      armedAt,
      appliedLeadIds: appliedLeads,
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
  encryptedLeadRetrievalAccessToken,
  encryptedAppSecret,
}) {
  const result = await pool.query(
    `INSERT INTO meta_connections (
       tenant_id, name, business_id, ad_account_id, app_id,
       encrypted_access_token, encrypted_lead_retrieval_access_token,
       encrypted_app_secret
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      tenantId(), name, businessId, adAccountId || null, appId || null,
      encryptedAccessToken, encryptedLeadRetrievalAccessToken || null,
      encryptedAppSecret || null,
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

export async function getNormalWa2RebindState(
  leadId,
  instanceId,
  rebindIdempotencyKey,
  confirmationIdempotencyKey,
) {
  const tenant = tenantId();
  const [activeLink, rebindHistory, verifiedIdentity, confirmation] = await Promise.all([
    getActiveWa2ContactLinkForLead(leadId, instanceId),
    pool.query(
      `SELECT * FROM lead_stage_history
       WHERE tenant_id = $1 AND lead_id = $2
         AND activity_type = $3
         AND metadata->>'idempotencyKey' = $4
       ORDER BY changed_at DESC
       LIMIT 1`,
      [tenant, leadId, WA2_CHAT_REBIND_ACTIVITY, rebindIdempotencyKey],
    ),
    pool.query(
      `SELECT * FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
       ORDER BY verified_at DESC
       LIMIT 1`,
      [tenant, leadId, instanceId],
    ),
    pool.query(
      `SELECT * FROM wa2_current_label_confirmations
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND idempotency_key = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenant, leadId, instanceId, confirmationIdempotencyKey],
    ),
  ]);
  return {
    activeLink,
    rebindHistory: rebindHistory.rows[0] || null,
    verifiedIdentity: verifiedIdentity.rows[0] || null,
    confirmation: confirmation.rows[0] || null,
  };
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

export async function replaceMetaConnectionLeadRetrievalToken(
  id,
  encryptedLeadRetrievalAccessToken,
) {
  const result = await pool.query(
    `UPDATE meta_connections
     SET encrypted_lead_retrieval_access_token = $3,
         updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, encryptedLeadRetrievalAccessToken],
  );
  return result.rows[0] || null;
}

export async function setMetaDatasetActive(id, active) {
  const result = await pool.query(
    `UPDATE meta_datasets
     SET active = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING *`,
    [tenantId(), id, active === true],
  );
  return result.rows[0] || null;
}

export async function getMetaCleanCanarySnapshot({
  leadId,
  datasetId = META_CLEAN_DATASET_ID,
} = {}) {
  const tenant = tenantId();
  const safeLeadId = String(leadId || '').trim();
  const safeDatasetId = String(datasetId || '').trim();
  if (!safeLeadId) throw new Error('META_CLEAN_LEAD_ID_REQUIRED');
  if (safeDatasetId !== META_CLEAN_DATASET_ID || safeDatasetId === META_LEGACY_DATASET_ID) {
    throw new Error('META_CLEAN_DATASET_INVALID');
  }
  const [leadResult, linksResult, identitiesResult, confirmationResult,
    datasetResult, eventsResult, jobsResult, legacyResult] = await Promise.all([
    pool.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT link.*, instance.name AS instance_name,
              instance.remote_instance_id, instance.enabled AS instance_enabled
       FROM wa2_contact_links link
       JOIN wa2_instances instance
         ON instance.tenant_id = link.tenant_id AND instance.id = link.wa2_instance_id
       WHERE link.tenant_id = $1 AND link.lead_id = $2 AND link.unlinked_at IS NULL
       ORDER BY link.created_at DESC`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT identity.*
       FROM lead_verified_whatsapp_identities identity
       WHERE identity.tenant_id = $1 AND identity.lead_id = $2
         AND identity.verified = true
       ORDER BY identity.verified_at DESC`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT confirmation.*
       FROM wa2_current_label_confirmations confirmation
       WHERE confirmation.tenant_id = $1 AND confirmation.lead_id = $2
         AND confirmation.result = 'STAGE_ALIGNED'
         AND confirmation.resulting_stage = 'QUALIFIED'
       ORDER BY confirmation.confirmed_at DESC, confirmation.created_at DESC
       LIMIT 1`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT dataset.*, connection.name AS connection_name,
              connection.status AS connection_status,
              connection.active AS connection_active
       FROM meta_datasets dataset
       JOIN meta_connections connection
         ON connection.tenant_id = dataset.tenant_id
        AND connection.id = dataset.meta_connection_id
       WHERE dataset.tenant_id = $1 AND dataset.dataset_id = $2
       LIMIT 1`,
      [tenant, safeDatasetId],
    ),
    pool.query(
      `SELECT event.id, event.event_id, event.event_name, event.event_time,
              event.status, event.validity_status, event.attempts,
              event.meta_connection_id, event.meta_dataset_id,
              event.sent_at, event.created_at, event.updated_at,
              event.meta_response->>'events_received' AS events_received,
              event.meta_response->>'fbtrace_id' AS fbtrace_id
       FROM meta_conversion_events event
       WHERE event.tenant_id = $1 AND event.lead_id = $2
         AND event.event_name = 'Marketing Qualified Lead'
       ORDER BY event.updated_at DESC, event.created_at DESC`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT job.id, job.status, job.attempts, job.last_error,
              job.completed_at, job.created_at, job.updated_at,
              job.dedupe_key, job.payload
       FROM meta_jobs job
       JOIN meta_conversion_events event
         ON event.tenant_id = job.tenant_id
        AND job.job_type = 'CONVERSION'
        AND job.payload->>'eventId' = event.id::text
        AND event.validity_status = 'VALID'
       WHERE job.tenant_id = $1 AND event.lead_id = $2
       ORDER BY job.created_at DESC`,
      [tenant, safeLeadId],
    ),
    pool.query(
      `SELECT dataset.id, dataset.dataset_id, dataset.active,
              dataset.meta_connection_id, connection.name AS connection_name
       FROM meta_datasets dataset
       JOIN meta_connections connection
         ON connection.tenant_id = dataset.tenant_id
        AND connection.id = dataset.meta_connection_id
       WHERE dataset.tenant_id = $1 AND dataset.dataset_id = $2
       ORDER BY dataset.created_at`,
      [tenant, META_LEGACY_DATASET_ID],
    ),
  ]);
  return {
    tenantId: tenant,
    lead: leadResult.rows[0] || null,
    activeLinks: linksResult.rows,
    verifiedIdentities: identitiesResult.rows,
    currentConfirmation: confirmationResult.rows[0] || null,
    dataset: datasetResult.rows[0] || null,
    events: eventsResult.rows,
    jobs: jobsResult.rows,
    legacyDatasets: legacyResult.rows,
  };
}

export const VERIFIED_WHATSAPP_SOURCE = 'USER_CONFIRMED_CONTACT_MATHEUS_PH_2026_08_04';
export const VERIFIED_WHATSAPP_REASON = 'BRAZIL_NINTH_DIGIT_LEGACY_ALIAS';

export async function listVerifiedWhatsAppIdentitiesForLead(leadId) {
  const result = await pool.query(
    `SELECT identity.*, instance.name AS instance_name,
            instance.remote_instance_id
     FROM lead_verified_whatsapp_identities identity
     JOIN wa2_instances instance
       ON instance.tenant_id = identity.tenant_id
      AND instance.id = identity.wa2_instance_id
     WHERE identity.tenant_id = $1 AND identity.lead_id = $2
     ORDER BY identity.verified_at DESC`,
    [tenantId(), leadId],
  );
  return result.rows;
}

function verifiedIdentityText(value, maxLength, field) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    throw new Wa2DataError(`Evidência ${field} inválida`, 'WA2_VERIFIED_IDENTITY_INVALID');
  }
  return text;
}

function verifiedIdentityJid(value, pattern, field) {
  const text = verifiedIdentityText(value, 255, field).toLowerCase();
  if (!pattern.test(text)) {
    throw new Wa2DataError(`Evidência ${field} inválida`, 'WA2_VERIFIED_IDENTITY_INVALID');
  }
  return text;
}

export async function createVerifiedWhatsAppIdentityAndLink({
  leadId,
  instanceId,
  expectedPhoneNormalized,
  resolved,
  evidence,
  actor,
}) {
  const identity = getBrazilianPhoneIdentity(expectedPhoneNormalized, { confirmedMobile: true });
  if (
    !identity.canonicalE164 ||
    ![
      'BR_MOBILE_CANONICAL',
      'BR_MOBILE_LEGACY',
    ].includes(identity.classification)
  ) {
    throw new Wa2DataError(
      'A identidade verificada precisa ser um móvel brasileiro',
      'WA2_VERIFIED_IDENTITY_PHONE_INVALID',
    );
  }
  if (!resolved?.contact?.id || !resolved?.chat?.id || !resolved?.contact?.jid) {
    throw new Wa2DataError(
      'Contato ou chat WA2 ausente na evidência',
      'WA2_VERIFIED_IDENTITY_INVALID',
    );
  }
  const canonicalPhone = identity.canonicalE164;
  const sourcePhone = verifiedIdentityText(
    evidence?.sourcePhoneNormalized ||
      resolved.contact.sourcePhoneNormalized ||
      resolved.contact.phoneNormalized,
    20,
    'sourcePhoneNormalized',
  );
  const sourceIdentity = getBrazilianPhoneIdentity(sourcePhone, { confirmedMobile: true });
  if (
    normalizeWhatsAppPhoneOrNull(sourcePhone) !== sourcePhone ||
    !sourceIdentity.canonicalE164 ||
    sourceIdentity.canonicalE164 !== canonicalPhone ||
    !['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY'].includes(sourceIdentity.classification)
  ) {
    throw new Wa2DataError(
      'A identidade WA2 não corresponde ao telefone canônico',
      'WA2_VERIFIED_IDENTITY_PHONE_MISMATCH',
    );
  }
  const phoneJid = verifiedIdentityJid(
    resolved.contact.jid,
    /^\d+@(s\.whatsapp\.net|c\.us)$/,
    'phoneJid',
  );
  const evidenceLidJid = evidence?.lidJid
    ? verifiedIdentityJid(evidence.lidJid, /^[a-z0-9._:-]+@lid$/, 'lidJid')
    : null;
  const resolvedLidJid = String(resolved.chat.jid || '').toLowerCase().endsWith('@lid')
    ? verifiedIdentityJid(resolved.chat.jid, /^[a-z0-9._:-]+@lid$/, 'lidJid')
    : null;
  if (evidenceLidJid && resolvedLidJid && evidenceLidJid !== resolvedLidJid) {
    throw new Wa2DataError(
      'O LID da evidência não corresponde ao chat resolvido',
      'WA2_VERIFIED_IDENTITY_CHANGED',
    );
  }
  const lidJid = evidenceLidJid || resolvedLidJid;
  const evidenceMessageId = verifiedIdentityText(
    evidence?.waMessageId,
    255,
    'waMessageId',
  );
  const evidenceObservedAt = new Date(evidence?.observedAt);
  if (!Number.isFinite(evidenceObservedAt.getTime())) {
    throw new Wa2DataError(
      'Data da evidência WA2 inválida',
      'WA2_VERIFIED_IDENTITY_INVALID',
    );
  }
  const safeActor = optionalActor(actor) || 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT * FROM leads
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Wa2DataError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');
    if (!lead.is_internal_test || lead.meta_outbound_eligible !== false) {
      throw new Wa2DataError(
        'Identidade alternativa só pode ser registrada para teste interno bloqueado',
        'WA2_VERIFIED_IDENTITY_NOT_INTERNAL_TEST',
      );
    }
    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), instanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance) throw new Wa2DataError('Instância não encontrada', 'WA2_INSTANCE_NOT_FOUND');
    if (!instance.enabled) throw new Wa2DataError('Instância desabilitada', 'WA2_INSTANCE_DISABLED');

    const otherLeadResult = await client.query(
      `SELECT id FROM leads
       WHERE tenant_id = $1 AND id <> $2
         AND (phone_normalized = $3 OR whatsapp_normalized = $3)
       FOR UPDATE`,
      [tenantId(), leadId, canonicalPhone],
    );
    if (otherLeadResult.rowCount > 0) {
      throw new Wa2DataError(
        'O telefone canônico já pertence a outro lead',
        'WA2_VERIFIED_IDENTITY_CONFLICT',
      );
    }

    const existingIdentityResult = await client.query(
      `SELECT * FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND wa2_instance_id = $2 AND canonical_phone = $3
       FOR UPDATE`,
      [tenantId(), instanceId, canonicalPhone],
    );
    const existingIdentity = existingIdentityResult.rows[0];
    if (existingIdentity && existingIdentity.lead_id !== leadId) {
      throw new Wa2DataError(
        'A identidade WhatsApp já está vinculada a outro lead',
        'WA2_VERIFIED_IDENTITY_CONFLICT',
      );
    }
    if (
      existingIdentity &&
      (existingIdentity.remote_chat_id !== resolved.chat.id ||
        existingIdentity.phone_jid !== phoneJid ||
        existingIdentity.lid_jid !== lidJid)
    ) {
      throw new Wa2DataError(
        'A evidência da identidade WhatsApp mudou',
        'WA2_VERIFIED_IDENTITY_CHANGED',
      );
    }

    const activeLinksResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND unlinked_at IS NULL
         AND (lead_id = $3 OR remote_chat_id = $4)
       FOR UPDATE`,
      [tenantId(), instanceId, leadId, resolved.chat.id],
    );
    const activeConflict = activeLinksResult.rows.find(
      (link) => link.lead_id !== leadId || link.remote_chat_id !== resolved.chat.id,
    );
    if (activeConflict) {
      throw new Wa2DataError(
        'Já existe vínculo ativo conflitante para o lead ou chat',
        'WA2_LINK_CONFLICT',
      );
    }
    const currentLink = activeLinksResult.rows[0] || null;
    if (existingIdentity && currentLink && lead.whatsapp_normalized === canonicalPhone) {
      await client.query('COMMIT');
      return { identity: existingIdentity, link: currentLink, idempotent: true };
    }
    let savedIdentity = existingIdentity;
    if (!savedIdentity) {
      const insertedIdentity = await client.query(
        `INSERT INTO lead_verified_whatsapp_identities (
           tenant_id, lead_id, wa2_instance_id, canonical_phone, aliases,
           source_phone, phone_jid, lid_jid, verification_source,
           verification_reason, remote_contact_id, remote_chat_id,
           evidence_wa_message_id, evidence_observed_at, verified_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          lead.tenant_id,
          lead.id,
          instance.id,
          canonicalPhone,
          JSON.stringify(identity.aliases),
          sourcePhone,
          phoneJid,
          lidJid,
          VERIFIED_WHATSAPP_SOURCE,
          VERIFIED_WHATSAPP_REASON,
          resolved.contact.id,
          resolved.chat.id,
          evidenceMessageId,
          evidenceObservedAt,
          safeActor,
        ],
      );
      savedIdentity = insertedIdentity.rows[0];
    }

    await client.query(
      `UPDATE leads
       SET whatsapp_normalized = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [lead.tenant_id, lead.id, canonicalPhone],
    );

    let link = currentLink;
    if (!link) {
      link = await insertWa2ContactLink(client, {
        leadId: lead.id,
        instanceId: instance.id,
        expectedPhoneNormalized: canonicalPhone,
        resolved,
        actor: safeActor,
      });
    }
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'SYSTEM',$4,'WHATSAPP_IDENTITY_VERIFIED',$5)`,
      [
        lead.tenant_id,
        lead.id,
        lead.stage,
        'Identidade WhatsApp verificada e vínculo WA2 confirmado sem alterar a etapa.',
        {
          identityId: savedIdentity.id,
          canonicalPhone,
          aliases: identity.aliases,
          source: VERIFIED_WHATSAPP_SOURCE,
          reason: VERIFIED_WHATSAPP_REASON,
          evidenceWaMessageId: evidenceMessageId,
          remoteContactId: resolved.contact.id,
          remoteChatId: resolved.chat.id,
          lidJid,
          phoneJid,
        },
      ],
    );
    await client.query('COMMIT');
    return { identity: savedIdentity, link, idempotent: Boolean(existingIdentity && currentLink) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapWa2UniqueViolation(error);
  } finally {
    client.release();
  }
}

const DETERMINISTIC_IDENTITY_SOURCE = 'WA2_DETERMINISTIC_RECOVERY_2026_08_05';

function deterministicEvidenceReference({
  evidenceType,
  tenantIdValue,
  instanceId,
  chatId,
  contactId,
  phoneJid,
  lidJid,
  observedAt,
  waMessageId,
  evidenceReference,
}) {
  if (evidenceType === 'WA2_MESSAGE') return waMessageId;
  if (evidenceReference) return evidenceReference;
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    tenantId: tenantIdValue,
    instanceId,
    chatId,
    contactId,
    phoneJid,
    lidJid,
    observedAt: observedAt.toISOString(),
  })).digest('hex');
  return `contact-state:${digest}`;
}

export async function verifyExistingWa2Identity({
  leadId,
  instanceId,
  expectedPhoneNormalized,
  resolved,
  evidence,
  actor,
}) {
  const expectedIdentity = getBrazilianPhoneIdentity(expectedPhoneNormalized, { confirmedMobile: true });
  if (
    !expectedIdentity.canonicalE164 ||
    !['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY'].includes(expectedIdentity.classification)
  ) {
    throw new Wa2DataError('Telefone da identidade não é móvel brasileiro', 'WA2_IDENTITY_PHONE_INVALID');
  }
  if (!resolved?.contact?.id || !resolved?.chat?.id || !resolved?.contact?.jid) {
    throw new Wa2DataError('Evidência de contato/chat incompleta', 'WA2_IDENTITY_EVIDENCE_INVALID');
  }
  const contactPhone = String(
    resolved.contact.phoneNormalized || resolved.contact.sourcePhoneNormalized || '',
  ).trim();
  const contactIdentity = getBrazilianPhoneIdentity(contactPhone, { confirmedMobile: true });
  if (!contactIdentity.canonicalE164 || contactIdentity.canonicalE164 !== expectedIdentity.canonicalE164) {
    throw new Wa2DataError('PN não corresponde ao telefone canônico', 'WA2_IDENTITY_PHONE_CONFLICT');
  }
  const phoneJid = verifiedIdentityJid(
    resolved.contact.jid,
    /^\d+@(s\.whatsapp\.net|c\.us)$/,
    'phoneJid',
  );
  const chatJid = String(resolved.chat.jid || evidence?.lidJid || '').trim().toLowerCase();
  const lidJid = chatJid.endsWith('@lid')
    ? verifiedIdentityJid(chatJid, /^[a-z0-9._:-]+@lid$/, 'lidJid')
    : null;
  if (!lidJid) {
    throw new Wa2DataError('LID atual não foi resolvido', 'WA2_IDENTITY_LID_WITHOUT_PN');
  }
  if (evidence?.lidJid && String(evidence.lidJid).trim().toLowerCase() !== lidJid) {
    throw new Wa2DataError('LID da evidência diverge do chat', 'WA2_IDENTITY_EVIDENCE_CHANGED');
  }

  const evidenceType = String(evidence?.type || '').trim();
  if (!['WA2_MESSAGE', 'WA2_CONTACT_STATE', 'WA2_CURRENT_LABEL_STATE'].includes(evidenceType)) {
    throw new Wa2DataError('Tipo de evidência não permitido', 'WA2_IDENTITY_EVIDENCE_INVALID');
  }
  const observedAt = new Date(evidence?.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Wa2DataError('Data da evidência inválida', 'WA2_IDENTITY_EVIDENCE_INVALID');
  }
  const waMessageId = evidenceType === 'WA2_MESSAGE'
    ? verifiedIdentityText(evidence?.waMessageId, 255, 'waMessageId')
    : null;
  const evidenceReferenceInput = evidenceType === 'WA2_CURRENT_LABEL_STATE'
    ? verifiedIdentityText(evidence?.evidenceReference, 255, 'evidenceReference')
    : null;
  const safeActor = optionalActor(actor) || 'system:wa2-identity-recovery';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Wa2DataError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');
    if (lead.is_internal_test === true) {
      await client.query('ROLLBACK');
      return { classification: 'INTERNAL_TEST', idempotent: false, identity: null };
    }

    const leadPhoneCandidates = [lead.phone_normalized, lead.whatsapp_normalized]
      .filter(Boolean)
      .map((value) => {
        try {
          return getBrazilianPhoneIdentity(value, { confirmedMobile: true }).canonicalE164;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!leadPhoneCandidates.includes(expectedIdentity.canonicalE164)) {
      throw new Wa2DataError('Telefone do lead diverge da identidade', 'WA2_IDENTITY_PHONE_CONFLICT');
    }

    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2 AND enabled = true
       FOR UPDATE`,
      [tenantId(), instanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance) throw new Wa2DataError('Instância WA2 não encontrada', 'WA2_INSTANCE_NOT_FOUND');

    const linkResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND lead_id = $3 AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), instanceId, leadId],
    );
    if (linkResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { classification: 'NO_ACTIVE_LINK', idempotent: false, identity: null };
    }
    if (linkResult.rowCount !== 1) {
      throw new Wa2DataError('Lead possui múltiplos vínculos WA2 ativos', 'WA2_IDENTITY_MULTIPLE_IDENTITIES');
    }
    const link = linkResult.rows[0];
    if (link.remote_chat_id !== resolved.chat.id || link.remote_contact_id !== resolved.contact.id) {
      throw new Wa2DataError('Chat ou contato não corresponde ao vínculo ativo', 'WA2_IDENTITY_EVIDENCE_CHANGED');
    }
    const linkIdentity = getBrazilianPhoneIdentity(link.phone_normalized, { confirmedMobile: true });
    if (linkIdentity.canonicalE164 !== expectedIdentity.canonicalE164) {
      throw new Wa2DataError('Telefone do vínculo diverge da identidade', 'WA2_IDENTITY_PHONE_CONFLICT');
    }

    const chatConflict = await client.query(
      `SELECT id FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND remote_chat_id = $3 AND lead_id <> $4 AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), instanceId, resolved.chat.id, leadId],
    );
    if (chatConflict.rowCount > 0) {
      throw new Wa2DataError('Chat WA2 já está vinculado a outro lead', 'WA2_IDENTITY_USED_BY_ANOTHER_LEAD');
    }

    const identityResult = await client.query(
      `SELECT * FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND (canonical_phone = $3 OR phone_jid = $4 OR lid_jid = $5)
       FOR UPDATE`,
      [tenantId(), instanceId, expectedIdentity.canonicalE164, phoneJid, lidJid],
    );
    const otherLeadIdentity = identityResult.rows.find((row) => row.lead_id !== leadId);
    if (otherLeadIdentity) {
      throw new Wa2DataError('Identidade WA2 já pertence a outro lead', 'WA2_IDENTITY_USED_BY_ANOTHER_LEAD');
    }
    if (identityResult.rowCount > 1) {
      throw new Wa2DataError('Mais de uma identidade candidata foi encontrada', 'WA2_IDENTITY_MULTIPLE_IDENTITIES');
    }
    const existing = identityResult.rows[0] || null;
    if (existing) {
      if (
        existing.remote_chat_id !== resolved.chat.id ||
        existing.remote_contact_id !== resolved.contact.id ||
        existing.phone_jid !== phoneJid ||
        existing.lid_jid !== lidJid ||
        existing.canonical_phone !== expectedIdentity.canonicalE164
      ) {
        throw new Wa2DataError('Identidade existente diverge da evidência atual', 'WA2_IDENTITY_EVIDENCE_CHANGED');
      }
      await client.query('COMMIT');
      return { classification: 'ALREADY_VERIFIED', idempotent: true, identity: existing, link };
    }

    const evidenceReference = deterministicEvidenceReference({
      evidenceType,
      tenantIdValue: tenantId(),
      instanceId,
      chatId: resolved.chat.id,
      contactId: resolved.contact.id,
      phoneJid,
      lidJid,
      observedAt,
      waMessageId,
      evidenceReference: evidenceReferenceInput,
    });
    const inserted = await client.query(
      `INSERT INTO lead_verified_whatsapp_identities (
         tenant_id, lead_id, wa2_instance_id, canonical_phone, aliases,
         source_phone, phone_jid, lid_jid, verification_source,
         verification_reason, remote_contact_id, remote_chat_id,
         evidence_wa_message_id, evidence_observed_at, verified_by,
         evidence_type, evidence_reference
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        lead.tenant_id, lead.id, instance.id, expectedIdentity.canonicalE164,
        JSON.stringify(expectedIdentity.aliases), contactPhone, phoneJid, lidJid,
        DETERMINISTIC_IDENTITY_SOURCE,
        evidenceType === 'WA2_CURRENT_LABEL_STATE'
          ? 'WA2_CURRENT_LABEL_STATE'
          : evidenceType === 'WA2_CONTACT_STATE' ? 'WA2_CURRENT_CONTACT_STATE' : 'WA2_MESSAGE_EVIDENCE',
        resolved.contact.id, resolved.chat.id, waMessageId, observedAt, safeActor,
        evidenceType, evidenceReference,
      ],
    );
    const saved = inserted.rows[0];
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'SYSTEM',$4,'WHATSAPP_IDENTITY_VERIFIED',$5)`,
      [
        lead.tenant_id, lead.id, lead.stage,
        'Identidade WA2 verificada por evidência determinística sem alterar a etapa.',
        {
          identityId: saved.id,
          evidenceType,
          evidenceReference,
          canonicalPhone: expectedIdentity.canonicalE164,
          chatHash: crypto.createHash('sha256').update(resolved.chat.id).digest('hex'),
          contactHash: crypto.createHash('sha256').update(resolved.contact.id).digest('hex'),
          source: DETERMINISTIC_IDENTITY_SOURCE,
        },
      ],
    );
    await client.query('COMMIT');
    return { classification: 'SAFE_TO_VERIFY', idempotent: false, identity: saved, link };
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapWa2UniqueViolation(error);
  } finally {
    client.release();
  }
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
      resolved.contact?.jid || resolved.chat.jid,
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
              lead.whatsapp_normalized AS current_whatsapp_phone,
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
    const currentLeadPhone = link.current_whatsapp_phone || link.current_lead_phone;
    if (
      normalizeWhatsAppPhone(currentLeadPhone) !==
      normalizeWhatsAppPhone(link.phone_normalized)
    ) {
      throw new Wa2DataError(
        'O telefone do lead mudou durante a verificação',
        'WA2_LEAD_PHONE_CHANGED',
      );
    }
    if (
      link.remote_contact_id !== resolved.contact.id ||
      link.remote_chat_id !== resolved.chat.id ||
      link.jid !== (resolved.contact?.jid || resolved.chat.jid) ||
      normalizeWhatsAppPhone(link.phone_normalized) !==
        normalizeWhatsAppPhone(resolved.contact.phoneNormalized)
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

export async function rebindVerifiedWa2IdentityToChat({
  requestedTenantId = tenantId(),
  leadId,
  instanceId,
  expectedActiveLinkId,
  expectedOldRemoteChatId,
  newRemoteChatId,
  newRemoteContactId,
  newRemoteJid,
  canonicalPhone,
  pn,
  lid,
  evidenceWaMessageId,
  evidenceTimestamp,
  evidence,
  reason = WA2_CHAT_REBIND_REASON,
  actor = null,
  idempotencyKey,
  dryRun = false,
}) {
  if (requestedTenantId !== tenantId()) {
    throw new Wa2DataError('Tenant do rebind inválido', 'WA2_REBIND_TENANT_CONFLICT');
  }
  if (!leadId || !instanceId || !expectedActiveLinkId || !expectedOldRemoteChatId || !newRemoteChatId) {
    throw new Wa2DataError('Identificadores do rebind incompletos', 'WA2_REBIND_INPUT_INVALID');
  }
  if (expectedOldRemoteChatId === newRemoteChatId) {
    throw new Wa2DataError('O novo chat precisa ser diferente do chat antigo', 'WA2_REBIND_CHAT_NOT_NEW');
  }
  if (reason !== WA2_CHAT_REBIND_REASON) {
    throw new Wa2DataError('Razão de rebind inválida', 'WA2_REBIND_REASON_INVALID');
  }
  const safeActor = optionalActor(actor) || 'system';
  const safeIdempotencyKey = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9:._-]{16,255}$/.test(safeIdempotencyKey)) {
    throw new Wa2DataError('Idempotency key inválida', 'WA2_REBIND_IDEMPOTENCY_INVALID');
  }
  const safeEvidenceTimestamp = new Date(evidenceTimestamp);
  if (!Number.isFinite(safeEvidenceTimestamp.getTime())) {
    throw new Wa2DataError('Timestamp da evidência inválido', 'WA2_REBIND_EVIDENCE_INVALID');
  }
  let canonicalIdentity;
  try {
    canonicalIdentity = getBrazilianPhoneIdentity(canonicalPhone, { confirmedMobile: true });
    verifiedIdentityJid(newRemoteJid, /^\d+@(s\.whatsapp\.net|c\.us)$/, 'phoneJid');
    verifiedIdentityJid(pn, /^\d+@(s\.whatsapp\.net|c\.us)$/, 'phoneJid');
    verifiedIdentityJid(lid, /^[a-z0-9._:-]+@lid$/, 'lidJid');
    validateRebindAdapterEvidence(evidence, {
      instanceId: evidence?.instanceId,
      chatId: newRemoteChatId,
      contactId: newRemoteContactId,
      waMessageId: evidenceWaMessageId,
      lidJid: lid,
      phoneJid: pn,
      observedAt: safeEvidenceTimestamp,
    });
  } catch {
    throw new Wa2DataError('Evidência do rebind inválida', 'WA2_REBIND_EVIDENCE_INVALID');
  }
  if (
    !canonicalIdentity.canonicalE164 ||
    !['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY'].includes(canonicalIdentity.classification) ||
    canonicalIdentity.canonicalE164 !== canonicalPhone ||
    newRemoteJid !== pn
  ) {
    throw new Wa2DataError('Identidade canônica do rebind divergente', 'WA2_REBIND_IDENTITY_MISMATCH');
  }
  const payloadHash = rebindPayloadHash({
    leadId,
    instanceId,
    expectedActiveLinkId,
    expectedOldRemoteChatId,
    newRemoteChatId,
    newRemoteContactId,
    newRemoteJid,
    canonicalPhone,
    pn,
    lid,
    evidenceWaMessageId,
    evidenceTimestamp: safeEvidenceTimestamp,
    reason,
    idempotencyKey: safeIdempotencyKey,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT * FROM leads
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Wa2DataError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');

    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), instanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance || !instance.enabled) {
      throw new Wa2DataError('Instância WA2 inválida ou desabilitada', 'WA2_REBIND_INSTANCE_INVALID');
    }
    if (instance.remote_instance_id !== evidence.instanceId) {
      throw new Wa2DataError('Evidência pertence a outra instância', 'WA2_REBIND_INSTANCE_MISMATCH');
    }

    const historyResult = await client.query(
      `SELECT * FROM lead_stage_history
       WHERE tenant_id = $1 AND lead_id = $2
         AND activity_type = $3
         AND metadata->>'idempotencyKey' = $4
       FOR UPDATE`,
      [tenantId(), leadId, WA2_CHAT_REBIND_ACTIVITY, safeIdempotencyKey],
    );

    const activeLinksResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), leadId, instanceId],
    );
    const identityResult = await client.query(
      `SELECT * FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
       FOR UPDATE`,
      [tenantId(), leadId, instanceId],
    );

    if (historyResult.rowCount > 0) {
      const history = historyResult.rows[0];
      if (history.metadata?.payloadHash !== payloadHash) {
        throw new Wa2DataError(
          'Idempotency key reutilizada com payload diferente',
          'WA2_REBIND_IDEMPOTENCY_CONFLICT',
        );
      }
      const current = activeLinksResult.rows[0];
      const identity = identityResult.rows[0];
      if (
        activeLinksResult.rowCount !== 1 ||
        !current ||
        current.remote_chat_id !== newRemoteChatId ||
        current.remote_contact_id !== newRemoteContactId ||
        current.jid !== newRemoteJid ||
        identityResult.rowCount !== 1 ||
        !identity ||
        identity.remote_chat_id !== newRemoteChatId ||
        identity.remote_contact_id !== newRemoteContactId
      ) {
        throw new Wa2DataError('Rebind anterior não corresponde ao snapshot atual', 'WA2_REBIND_STATE_CONFLICT');
      }
      await client.query('COMMIT');
      return {
        status: 'ALREADY_REBOUND',
        idempotent: true,
        historyId: history.id,
        link: current,
        identity,
      };
    }

    if (activeLinksResult.rowCount !== 1) {
      throw new Wa2DataError('Quantidade de vínculos ativos inesperada', 'WA2_REBIND_LINK_COUNT');
    }
    if (identityResult.rowCount !== 1 || identityResult.rows[0].verified !== true) {
      throw new Wa2DataError('Identidade verificada ausente ou ambígua', 'WA2_REBIND_IDENTITY_COUNT');
    }
    const current = activeLinksResult.rows[0];
    const identity = identityResult.rows[0];
    if (current.id !== expectedActiveLinkId || current.remote_chat_id !== expectedOldRemoteChatId) {
      throw new Wa2DataError('Vínculo ativo esperado mudou', 'WA2_REBIND_LINK_CHANGED');
    }
    if (
      identity.canonical_phone !== canonicalPhone ||
      identity.phone_jid !== pn ||
      identity.lid_jid !== lid ||
      !sameAliasSet(identity.aliases, canonicalIdentity.aliases) ||
      current.phone_normalized !== canonicalPhone ||
      current.jid !== pn
    ) {
      throw new Wa2DataError('Identidade ou vínculo antigo divergente', 'WA2_REBIND_IDENTITY_MISMATCH');
    }
    if (lead.stage !== 'NEW') throw new Wa2DataError('A etapa do lead não é NEW', 'WA2_REBIND_STAGE_CHANGED');
    if (lead.is_internal_test !== true || lead.meta_outbound_eligible !== false) {
      throw new Wa2DataError('Lead não está protegido como INTERNAL_TEST', 'WA2_REBIND_INTERNAL_TEST_REQUIRED');
    }

    const conflictsResult = await client.query(
      `SELECT id FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND unlinked_at IS NULL
         AND id <> $5
         AND (remote_chat_id = $3 OR remote_contact_id = $4 OR jid = $6)
       FOR UPDATE`,
      [tenantId(), instanceId, newRemoteChatId, newRemoteContactId, expectedActiveLinkId, newRemoteJid],
    );
    if (conflictsResult.rowCount > 0) {
      throw new Wa2DataError('Novo chat ou contato já possui vínculo ativo', 'WA2_REBIND_LINK_CONFLICT');
    }
    const otherLeadResult = await client.query(
      `SELECT count(*)::int AS count FROM leads
       WHERE tenant_id = $1 AND id <> $2
         AND (phone_normalized = $3 OR whatsapp_normalized = $3)`,
      [tenantId(), leadId, canonicalPhone],
    );
    if (Number(otherLeadResult.rows[0]?.count || 0) !== 0) {
      throw new Wa2DataError('Telefone canônico pertence a outro lead', 'WA2_REBIND_LEAD_CONFLICT');
    }
    const otherIdentityResult = await client.query(
      `SELECT count(*)::int AS count FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND canonical_phone = $3 AND lead_id <> $4`,
      [tenantId(), instanceId, canonicalPhone, leadId],
    );
    if (Number(otherIdentityResult.rows[0]?.count || 0) !== 0) {
      throw new Wa2DataError('Identidade canônica pertence a outro lead', 'WA2_REBIND_IDENTITY_CONFLICT');
    }

    const [labelResult, actionResult, conflictResult, metaResult, jobResult] = await Promise.all([
      client.query(
        `WITH latest AS (
           SELECT DISTINCT ON (remote_chat_id, remote_label_id)
                  remote_chat_id, remote_label_id, operation
           FROM wa2_label_event_receipts
           WHERE tenant_id = $1 AND remote_chat_id = ANY($2::text[])
           ORDER BY remote_chat_id, remote_label_id,
                    observed_at DESC NULLS LAST, received_at DESC NULLS LAST, id DESC
         )
         SELECT count(*)::int AS count
         FROM latest
         JOIN wa2_label_bindings binding
           ON binding.tenant_id = $1
          AND binding.wa2_instance_id = $3
          AND binding.remote_label_id = latest.remote_label_id
          AND binding.enabled = true
         WHERE latest.operation = 'APPLY'
           AND binding.remote_label_name IN ('CRM 01 - Em atendimento','CRM 02 - Qualificado')`,
        [tenantId(), [expectedOldRemoteChatId, newRemoteChatId], instanceId],
      ),
      client.query(
        `SELECT count(*)::int AS count FROM wa2_inbound_label_actions
         WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId(), leadId],
      ),
      client.query(
        `SELECT count(*)::int AS count FROM wa2_label_conflicts
         WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId(), leadId],
      ),
      client.query(
        `SELECT count(*)::int AS count FROM meta_conversion_events
         WHERE tenant_id = $1 AND lead_id = $2`,
        [tenantId(), leadId],
      ),
      client.query(
        `SELECT count(*)::int AS count FROM meta_jobs
         WHERE tenant_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
        [tenantId(), leadId],
      ),
    ]);
    if (Number(labelResult.rows[0]?.count || 0) !== 0) {
      throw new Wa2DataError('CRM01 ou CRM02 já está aplicado', 'WA2_REBIND_STAGE_LABEL_PRESENT');
    }
    if (
      Number(actionResult.rows[0]?.count || 0) !== 0 ||
      Number(conflictResult.rows[0]?.count || 0) !== 0 ||
      Number(metaResult.rows[0]?.count || 0) !== 0 ||
      Number(jobResult.rows[0]?.count || 0) !== 0
    ) {
      throw new Wa2DataError('Lead possui atividade protegida incompatível com o rebind', 'WA2_REBIND_STATE_CONFLICT');
    }

    if (dryRun === true) {
      await client.query('ROLLBACK');
      return {
        status: 'DRY_RUN_VALID',
        classification: 'A',
        sameInstance: true,
        canonicalPhoneMatch: true,
        aliasesMatch: true,
        pnMatch: true,
        lidMatch: true,
        evidenceValid: true,
        currentActiveLinks: 1,
        newChatActiveLinks: 0,
        otherLeadCandidates: 0,
        conflicts: 0,
        wouldSupersede: 1,
        wouldCreateOrActivate: 1,
        wouldUpdateIdentity: 1,
        wouldCreateHistory: 1,
        wouldChangeStage: false,
        wouldCreateMeta: false,
      };
    }

    const oldLinkResult = await client.query(
      `UPDATE wa2_contact_links
       SET unlinked_at = now(), unlinked_by = $2,
           unlink_reason = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $4 AND unlinked_at IS NULL
       RETURNING *`,
      [tenantId(), safeActor, reason, current.id],
    );
    if (oldLinkResult.rowCount !== 1) {
      throw new Wa2DataError('Vínculo antigo mudou durante o rebind', 'WA2_REBIND_LINK_CHANGED');
    }
    const newLinkResult = await client.query(
      `INSERT INTO wa2_contact_links (
         tenant_id, lead_id, wa2_instance_id, remote_contact_id,
         remote_chat_id, jid, phone_normalized, linked_by,
         resolved_at, last_verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
       RETURNING *`,
      [tenantId(), leadId, instanceId, newRemoteContactId, newRemoteChatId, newRemoteJid, canonicalPhone, safeActor],
    );
    const newLink = newLinkResult.rows[0];
    const identityResultUpdated = await client.query(
      `UPDATE lead_verified_whatsapp_identities
       SET remote_contact_id = $4, remote_chat_id = $5,
           phone_jid = $6, lid_jid = $7,
           evidence_wa_message_id = $8, evidence_observed_at = $9,
           verified_at = now(), verified_by = $10, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND lead_id = $3
       RETURNING *`,
      [tenantId(), identity.id, leadId, newRemoteContactId, newRemoteChatId, pn, lid,
        evidenceWaMessageId, safeEvidenceTimestamp, safeActor],
    );
    if (identityResultUpdated.rowCount !== 1) {
      throw new Wa2DataError('Identidade não pôde ser atualizada', 'WA2_REBIND_IDENTITY_CHANGED');
    }
    const metadata = createRebindHistoryMetadata({
      identityId: identity.id,
      oldLinkId: current.id,
      newLinkId: newLink.id,
      instanceId,
      oldRemoteChatId: expectedOldRemoteChatId,
      newRemoteChatId,
      remoteContactId: newRemoteContactId,
      pn,
      lid,
      evidenceWaMessageId,
      evidenceTimestamp: safeEvidenceTimestamp,
      reason,
      actor: safeActor,
      idempotencyKey: safeIdempotencyKey,
      payloadHash,
    });
    const rebindHistoryResult = await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,'NEW','NEW','SYSTEM',$3,$4,$5)
       RETURNING id`,
      [
        tenantId(), leadId,
        'Rebind determinístico da identidade WhatsApp após recriação do chat.',
        WA2_CHAT_REBIND_ACTIVITY,
        metadata,
      ],
    );
    await client.query('COMMIT');
    return {
      status: 'REBIND_COMPLETED',
      idempotent: false,
      link: newLink,
      identity: identityResultUpdated.rows[0],
      historyId: rebindHistoryResult.rows[0].id,
      oldLink: oldLinkResult.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw mapWa2UniqueViolation(error);
  } finally {
    client.release();
  }
}

export async function rebindNormalLeadToCurrentWa2Chat({
  requestedTenantId = tenantId(),
  leadId,
  instanceId,
  expectedActiveLinkId,
  expectedOldRemoteChatId,
  newRemoteChatId,
  newRemoteContactId,
  newRemoteJid,
  canonicalPhone,
  pn,
  lid,
  remoteLabelId,
  remoteLabelName,
  remoteInstanceId,
  operation = 'APPLY',
  evidenceType,
  evidenceReference,
  sourceEventId,
  observedAt,
  reason = WA2_NORMAL_CHAT_REBIND_REASON,
  actor = null,
  idempotencyKey,
  dryRun = false,
}) {
  if (requestedTenantId !== tenantId()) {
    throw new Wa2DataError('Tenant do rebind inválido', 'WA2_NORMAL_REBIND_TENANT_CONFLICT');
  }
  if (!leadId || !instanceId || !expectedActiveLinkId || !expectedOldRemoteChatId || !newRemoteChatId) {
    throw new Wa2DataError('Identificadores do rebind incompletos', 'WA2_NORMAL_REBIND_INPUT_INVALID');
  }
  if (expectedOldRemoteChatId === newRemoteChatId) {
    throw new Wa2DataError('O novo chat precisa ser diferente do chat antigo', 'WA2_NORMAL_REBIND_CHAT_NOT_NEW');
  }
  if (reason !== WA2_NORMAL_CHAT_REBIND_REASON) {
    throw new Wa2DataError('Razão de rebind inválida', 'WA2_NORMAL_REBIND_REASON_INVALID');
  }
  const safeActor = optionalActor(actor) || 'system:wa2-normal-rebind';
  const safeIdempotencyKey = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/.test(safeIdempotencyKey)) {
    throw new Wa2DataError('Idempotency key inválida', 'WA2_NORMAL_REBIND_IDEMPOTENCY_INVALID');
  }
  let canonicalIdentity;
  let evidenceSnapshot;
  try {
    canonicalIdentity = getBrazilianPhoneIdentity(canonicalPhone, { confirmedMobile: true });
    if (
      !canonicalIdentity.canonicalE164 ||
      !['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY'].includes(canonicalIdentity.classification)
    ) throw new Error('Telefone canônico inválido');
    verifiedIdentityJid(newRemoteJid, /^\d+@(s\.whatsapp\.net|c\.us)$/, 'newRemoteJid');
    verifiedIdentityJid(pn, /^\d+@(s\.whatsapp\.net|c\.us)$/, 'pn');
    verifiedIdentityJid(lid, /^[a-z0-9._:-]+@lid$/, 'lid');
    if (newRemoteJid !== pn) throw new Error('PN divergente');
    evidenceSnapshot = validateCurrentLabelEvidence({
      tenantId: requestedTenantId,
      leadId,
      instanceId: remoteInstanceId,
      chatId: newRemoteChatId,
      contactId: newRemoteContactId,
      remoteLabelId,
      remoteLabelName,
      operation,
      observedAt,
      evidenceType,
      evidenceReference,
      sourceEventId,
    });
  } catch {
    throw new Wa2DataError('Evidência atual da etiqueta inválida', 'WA2_NORMAL_REBIND_EVIDENCE_INVALID');
  }
  if (remoteLabelId !== '36' || remoteLabelName !== 'CRM 02 - Qualificado') {
    throw new Wa2DataError('O rebind normal desta unidade exige CRM02', 'WA2_NORMAL_REBIND_LABEL_INVALID');
  }
  const payloadHash = normalRebindPayloadHash({
    leadId,
    instanceId,
    expectedActiveLinkId,
    expectedOldRemoteChatId,
    newRemoteChatId,
    newRemoteContactId,
    newRemoteJid,
    canonicalPhone: canonicalIdentity.canonicalE164,
    pn,
    lid,
    remoteLabelId,
    remoteLabelName,
    evidenceType,
    evidenceReference,
    sourceEventId,
    remoteInstanceId,
    observedAt: evidenceSnapshot.observedAt,
    reason,
    idempotencyKey: safeIdempotencyKey,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Wa2DataError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');
    if (lead.is_internal_test === true) {
      throw new Wa2DataError('Lead INTERNAL_TEST não pode usar rebind normal', 'WA2_NORMAL_REBIND_INTERNAL_TEST');
    }
    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2 AND enabled = true
       FOR UPDATE`,
      [tenantId(), instanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance || instance.name !== '2298 UNIVC') {
      throw new Wa2DataError('Instância WA2 normal inválida', 'WA2_NORMAL_REBIND_INSTANCE_INVALID');
    }
    if (instance.remote_instance_id !== evidenceSnapshot.instanceId) {
      throw new Wa2DataError('Evidência pertence a outra instância', 'WA2_NORMAL_REBIND_INSTANCE_MISMATCH');
    }

    const historyResult = await client.query(
      `SELECT * FROM lead_stage_history
       WHERE tenant_id = $1 AND lead_id = $2
         AND activity_type = $3
         AND metadata->>'idempotencyKey' = $4
       FOR UPDATE`,
      [tenantId(), leadId, WA2_CHAT_REBIND_ACTIVITY, safeIdempotencyKey],
    );

    const activeLinksResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), leadId, instanceId],
    );
    if (historyResult.rowCount > 0) {
      const history = historyResult.rows[0];
      if (history.metadata?.payloadHash !== payloadHash) {
        throw new Wa2DataError('Idempotency key reutilizada com payload diferente', 'WA2_NORMAL_REBIND_IDEMPOTENCY_CONFLICT');
      }
      const current = activeLinksResult.rows[0];
      if (
        activeLinksResult.rowCount !== 1 ||
        current.remote_chat_id !== newRemoteChatId ||
        current.remote_contact_id !== newRemoteContactId ||
        current.jid !== newRemoteJid
      ) {
        throw new Wa2DataError('Rebind anterior não corresponde ao snapshot atual', 'WA2_NORMAL_REBIND_STATE_CONFLICT');
      }
      await client.query('COMMIT');
      return {
        status: 'ALREADY_REBOUND',
        idempotent: true,
        historyId: history.id,
        link: current,
        currentActiveLinks: 1,
        newChatActiveLinks: 1,
      };
    }
    if (lead.stage !== 'NEW') {
      throw new Wa2DataError('A etapa do lead não é NEW', 'WA2_NORMAL_REBIND_STAGE_CHANGED');
    }
    if (activeLinksResult.rowCount !== 1) {
      throw new Wa2DataError('Quantidade de vínculos ativos inesperada', 'WA2_NORMAL_REBIND_LINK_COUNT');
    }
    const current = activeLinksResult.rows[0];
    const currentIdentity = getBrazilianPhoneIdentity(current.phone_normalized, { confirmedMobile: true });
    if (
      current.id !== expectedActiveLinkId ||
      current.remote_chat_id !== expectedOldRemoteChatId ||
      currentIdentity.canonicalE164 !== canonicalIdentity.canonicalE164
    ) {
      throw new Wa2DataError('Vínculo ativo legado mudou ou diverge', 'WA2_NORMAL_REBIND_LINK_CHANGED');
    }

    const bindingResult = await client.query(
      `SELECT * FROM wa2_label_bindings
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND remote_label_id = $3 AND enabled = true
       FOR UPDATE`,
      [tenantId(), instanceId, remoteLabelId],
    );
    if (
      bindingResult.rowCount !== 1 ||
      bindingResult.rows[0].stage !== 'QUALIFIED' ||
      bindingResult.rows[0].remote_label_name !== remoteLabelName
    ) {
      throw new Wa2DataError('Binding CRM02 ausente ou divergente', 'WA2_NORMAL_REBIND_BINDING_INVALID');
    }

    const conflictsResult = await client.query(
      `SELECT id FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND unlinked_at IS NULL AND id <> $5
         AND (remote_chat_id = $3 OR remote_contact_id = $4 OR jid = $6)
       FOR UPDATE`,
      [tenantId(), instanceId, newRemoteChatId, newRemoteContactId, current.id, newRemoteJid],
    );
    if (conflictsResult.rowCount > 0) {
      throw new Wa2DataError('Novo chat, contato ou PN já possui vínculo ativo', 'WA2_NORMAL_REBIND_LINK_CONFLICT');
    }

    const otherLeadResult = await client.query(
      `SELECT id FROM leads
       WHERE tenant_id = $1 AND id <> $2
         AND (phone_normalized = ANY($3::text[]) OR whatsapp_normalized = ANY($3::text[]))
       FOR UPDATE`,
      [tenantId(), leadId, canonicalIdentity.aliases],
    );
    if (otherLeadResult.rowCount > 0) {
      throw new Wa2DataError('Telefone canônico ou alias pertence a outro lead', 'WA2_NORMAL_REBIND_LEAD_CONFLICT');
    }

    const otherIdentityResult = await client.query(
      `SELECT id FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND (canonical_phone = $3 OR phone_jid = $4 OR lid_jid = $5)
         AND lead_id <> $6
       FOR UPDATE`,
      [tenantId(), instanceId, canonicalIdentity.canonicalE164, pn, lid, leadId],
    );
    if (otherIdentityResult.rowCount > 0) {
      throw new Wa2DataError('Identidade pertence a outro lead', 'WA2_NORMAL_REBIND_IDENTITY_CONFLICT');
    }

    const manualResult = await client.query(
      `SELECT id FROM manual_stage_change_requests
       WHERE tenant_id = $1 AND lead_id = $2
         AND status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_WA', 'PENDING_WA_LINK')
       FOR UPDATE`,
      [tenantId(), leadId],
    );
    if (manualResult.rowCount > 0) {
      throw new Wa2DataError('Existe solicitação manual pendente', 'WA2_NORMAL_REBIND_MANUAL_PENDING');
    }

    const conflictResult = await client.query(
      `SELECT id FROM wa2_label_conflicts WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    if (conflictResult.rowCount > 0) {
      throw new Wa2DataError('Lead possui conflito WA2', 'WA2_NORMAL_REBIND_CONFLICT');
    }

    if (dryRun === true) {
      await client.query('ROLLBACK');
      return {
        status: 'DRY_RUN_VALID',
        classification: 'CRM_BEHIND_WHATSAPP',
        currentActiveLinks: 1,
        newChatActiveLinks: 0,
        otherLeadCandidates: 0,
        conflicts: 0,
        wouldSupersede: 1,
        wouldCreateOrActivate: 1,
        wouldCreateHistory: 1,
        wouldChangeStage: false,
        wouldCreateMeta: false,
      };
    }

    const oldLinkResult = await client.query(
      `UPDATE wa2_contact_links
       SET unlinked_at = now(), unlinked_by = $2,
           unlink_reason = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $4 AND unlinked_at IS NULL
       RETURNING *`,
      [tenantId(), safeActor, reason, current.id],
    );
    if (oldLinkResult.rowCount !== 1) {
      throw new Wa2DataError('Vínculo legado mudou durante o rebind', 'WA2_NORMAL_REBIND_LINK_CHANGED');
    }
    const newLinkResult = await client.query(
      `INSERT INTO wa2_contact_links (
         tenant_id, lead_id, wa2_instance_id, remote_contact_id,
         remote_chat_id, jid, phone_normalized, linked_by,
         resolved_at, last_verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
       RETURNING *`,
      [tenantId(), leadId, instanceId, newRemoteContactId, newRemoteChatId, newRemoteJid,
        canonicalIdentity.canonicalE164, safeActor],
    );
    const newLink = newLinkResult.rows[0];
    const metadata = createNormalRebindHistoryMetadata({
      oldLinkId: current.id,
      newLinkId: newLink.id,
      instanceId,
      oldRemoteChatId: expectedOldRemoteChatId,
      newRemoteChatId,
      remoteContactId: newRemoteContactId,
      pn,
      lid,
      evidenceReference,
      evidenceType,
      observedAt: evidenceSnapshot.observedAt,
      reason,
      actor: safeActor,
      idempotencyKey: safeIdempotencyKey,
      payloadHash,
    });
    const rebindHistoryResult = await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,'NEW','NEW','SYSTEM',$3,$4,$5)
       RETURNING id`,
      [
        tenantId(), leadId,
        'Rebind determinístico do lead normal para o chat atual com CRM02.',
        WA2_CHAT_REBIND_ACTIVITY,
        metadata,
      ],
    );
    await client.query('COMMIT');
    return {
      status: 'REBIND_COMPLETED',
      idempotent: false,
      oldLink: oldLinkResult.rows[0],
      link: newLink,
      historyId: rebindHistoryResult.rows[0].id,
      currentActiveLinks: 1,
      newChatActiveLinks: 1,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      throw new Wa2DataError('Vínculo WA2 normal conflitante', 'WA2_NORMAL_REBIND_LINK_CONFLICT');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmCurrentWa2LabelStateAndAlignLead({
  requestedTenantId = tenantId(),
  leadId,
  instanceId,
  activeLinkId,
  verifiedIdentityId,
  remoteChatId,
  remoteContactId,
  remoteLabelId,
  remoteLabelName,
  remoteInstanceId,
  operation = 'APPLY',
  evidenceType,
  evidenceReference,
  sourceEventId,
  observedAt,
  actor = null,
  idempotencyKey,
  dryRun = false,
}) {
  if (requestedTenantId !== tenantId()) {
    throw new Wa2DataError('Tenant da confirmação inválido', 'WA2_LABEL_CONFIRMATION_TENANT_CONFLICT');
  }
  const safeActor = optionalActor(actor) || 'system:wa2-current-label';
  const safeIdempotencyKey = String(idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/.test(safeIdempotencyKey)) {
    throw new Wa2DataError('Idempotency key inválida', 'WA2_LABEL_CONFIRMATION_IDEMPOTENCY_INVALID');
  }
  const evidenceSnapshot = validateCurrentLabelEvidence({
    tenantId: requestedTenantId,
    leadId,
    instanceId: remoteInstanceId,
    chatId: remoteChatId,
    contactId: remoteContactId,
    remoteLabelId,
    remoteLabelName,
    operation,
    observedAt,
    evidenceType,
    evidenceReference,
    sourceEventId,
  });
  if (remoteLabelId !== '36' || remoteLabelName !== 'CRM 02 - Qualificado') {
    throw new Wa2DataError('A confirmação desta unidade exige CRM02', 'WA2_LABEL_CONFIRMATION_LABEL_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw new Wa2DataError('Lead não encontrado', 'WA2_LEAD_NOT_FOUND');
    if (lead.is_internal_test === true) {
      throw new Wa2DataError('Lead INTERNAL_TEST não pode confirmar etapa normal', 'WA2_LABEL_CONFIRMATION_INTERNAL_TEST');
    }
    const existingResult = await client.query(
      `SELECT * FROM wa2_current_label_confirmations
       WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
         AND idempotency_key = $4
       FOR UPDATE`,
      [tenantId(), leadId, instanceId, safeIdempotencyKey],
    );
    if (existingResult.rowCount > 0) {
      const existing = existingResult.rows[0];
      if (
        existing.active_link_id !== activeLinkId ||
        existing.verified_identity_id !== verifiedIdentityId ||
        existing.remote_chat_id !== remoteChatId ||
        existing.remote_contact_id !== remoteContactId ||
        existing.remote_label_id !== remoteLabelId ||
        existing.evidence_reference !== evidenceReference
      ) {
        throw new Wa2DataError('Confirmação idempotente diverge do snapshot', 'WA2_LABEL_CONFIRMATION_STATE_CONFLICT');
      }
      await client.query('COMMIT');
      return {
        status: 'ALREADY_CONFIRMED',
        idempotent: true,
        confirmation: existing,
        stageStatus: lead.stage === 'QUALIFIED' ? 'ALREADY_ALIGNED' : 'STAGE_NOT_ALIGNED',
      };
    }
    if (lead.stage !== 'NEW') {
      throw new Wa2DataError('A etapa do lead mudou antes da confirmação', 'WA2_LABEL_CONFIRMATION_STAGE_CHANGED');
    }
    const instanceResult = await client.query(
      `SELECT * FROM wa2_instances
       WHERE tenant_id = $1 AND id = $2 AND enabled = true
       FOR UPDATE`,
      [tenantId(), instanceId],
    );
    const instance = instanceResult.rows[0];
    if (!instance || instance.name !== '2298 UNIVC') {
      throw new Wa2DataError('Instância da confirmação inválida', 'WA2_LABEL_CONFIRMATION_INSTANCE_INVALID');
    }
    if (instance.remote_instance_id !== evidenceSnapshot.instanceId) {
      throw new Wa2DataError('Evidência pertence a outra instância', 'WA2_LABEL_CONFIRMATION_INSTANCE_MISMATCH');
    }
    const linkResult = await client.query(
      `SELECT * FROM wa2_contact_links
       WHERE tenant_id = $1 AND wa2_instance_id = $2 AND lead_id = $3
         AND unlinked_at IS NULL
       FOR UPDATE`,
      [tenantId(), instanceId, leadId],
    );
    if (
      linkResult.rowCount !== 1 ||
      linkResult.rows[0].id !== activeLinkId ||
      linkResult.rows[0].remote_chat_id !== remoteChatId ||
      linkResult.rows[0].remote_contact_id !== remoteContactId
    ) {
      throw new Wa2DataError('Vínculo atual não corresponde à confirmação', 'WA2_LABEL_CONFIRMATION_LINK_INVALID');
    }
    const identityResult = await client.query(
      `SELECT * FROM lead_verified_whatsapp_identities
       WHERE tenant_id = $1 AND wa2_instance_id = $2 AND lead_id = $3
         AND id = $4 AND verified = true
       FOR UPDATE`,
      [tenantId(), instanceId, leadId, verifiedIdentityId],
    );
    if (identityResult.rowCount !== 1 || identityResult.rows[0].remote_chat_id !== remoteChatId) {
      throw new Wa2DataError('Identidade verificada não corresponde à confirmação', 'WA2_LABEL_CONFIRMATION_IDENTITY_INVALID');
    }
    const bindingResult = await client.query(
      `SELECT * FROM wa2_label_bindings
       WHERE tenant_id = $1 AND wa2_instance_id = $2
         AND remote_label_id = $3 AND enabled = true
       FOR UPDATE`,
      [tenantId(), instanceId, remoteLabelId],
    );
    if (
      bindingResult.rowCount !== 1 ||
      bindingResult.rows[0].stage !== 'QUALIFIED' ||
      bindingResult.rows[0].remote_label_name !== remoteLabelName
    ) {
      throw new Wa2DataError('Binding CRM02 ausente ou divergente', 'WA2_LABEL_CONFIRMATION_BINDING_INVALID');
    }
    const manualResult = await client.query(
      `SELECT id FROM manual_stage_change_requests
       WHERE tenant_id = $1 AND lead_id = $2
         AND status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_WA', 'PENDING_WA_LINK')
       FOR UPDATE`,
      [tenantId(), leadId],
    );
    if (manualResult.rowCount > 0) {
      throw new Wa2DataError('Existe solicitação manual pendente', 'WA2_LABEL_CONFIRMATION_MANUAL_PENDING');
    }
    const conflictResult = await client.query(
      `SELECT id FROM wa2_label_conflicts WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    if (conflictResult.rowCount > 0) {
      throw new Wa2DataError('Lead possui conflito WA2', 'WA2_LABEL_CONFIRMATION_CONFLICT');
    }
    if (dryRun === true) {
      await client.query('ROLLBACK');
      return {
        status: 'DRY_RUN_VALID',
        currentStage: lead.stage,
        resultingStage: 'QUALIFIED',
        wouldCreateAction: 1,
        wouldCreateHistory: 1,
        wouldChangeStage: true,
        wouldCreateMeta: false,
      };
    }
    const actionResult = await client.query(
      `INSERT INTO wa2_current_label_confirmations (
         tenant_id, lead_id, wa2_instance_id, active_link_id,
         verified_identity_id, remote_chat_id, remote_contact_id,
         remote_label_id, remote_label_name, binding_id, observed_at,
         evidence_type, evidence_reference, source_event_id, actor,
         idempotency_key, previous_stage, resulting_stage, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'QUALIFIED',$18)
       RETURNING *`,
      [
        tenantId(), leadId, instanceId, activeLinkId, verifiedIdentityId,
        remoteChatId, remoteContactId, remoteLabelId, remoteLabelName,
        bindingResult.rows[0].id, evidenceSnapshot.observedAt,
        evidenceType, evidenceReference, sourceEventId || null, safeActor,
        safeIdempotencyKey, lead.stage,
        {
          event: WA2_CURRENT_LABEL_CONFIRMATION_ACTIVITY,
          evidenceType,
          evidenceReferenceHash: crypto.createHash('sha256').update(evidenceReference).digest('hex'),
          sourceEventId,
          remoteChatHash: crypto.createHash('sha256').update(remoteChatId).digest('hex'),
          remoteContactHash: crypto.createHash('sha256').update(remoteContactId).digest('hex'),
          actor: safeActor,
        },
      ],
    );
    const action = actionResult.rows[0];
    const updated = await client.query(
      `UPDATE leads SET stage = 'QUALIFIED', stage_source = 'WHATSAPP_LABEL',
         source_label_id = $3, source_label_name = $4,
         source_action_id = $5, source_receipt_id = NULL,
         source_observed_at = $6, stage_verified_at = now(),
         stage_verification_status = 'VERIFIED', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND stage = 'NEW'
       RETURNING *`,
      [tenantId(), leadId, remoteLabelId, remoteLabelName, action.id, evidenceSnapshot.observedAt],
    );
    if (updated.rowCount !== 1) {
      throw new Wa2DataError('Etapa mudou durante a confirmação', 'WA2_LABEL_CONFIRMATION_STAGE_CHANGED');
    }
    const historyResult = await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,'NEW','QUALIFIED','WHATSAPP',$3,'STAGE_CHANGED',$4)
       RETURNING id`,
      [
        tenantId(), leadId,
        'Etapa confirmada pela etiqueta CRM02 atual do WhatsApp.',
        {
          confirmationId: action.id,
          sourceActionId: action.id,
          sourceLabelId: remoteLabelId,
          sourceLabelName: remoteLabelName,
          sourceObservedAt: evidenceSnapshot.observedAt,
          evidenceType,
          evidenceReferenceHash: crypto.createHash('sha256').update(evidenceReference).digest('hex'),
        },
      ],
    );
    await client.query('COMMIT');
    return {
      status: 'CONFIRMED_AND_ALIGNED',
      idempotent: false,
      confirmation: action,
      historyId: historyResult.rows[0].id,
      lead: updated.rows[0],
      stageStatus: 'ALIGNED',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      throw new Wa2DataError('Confirmação de etiqueta já existe', 'WA2_LABEL_CONFIRMATION_IDEMPOTENCY_CONFLICT');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createOrGetMetaEvent(
  client,
  { lead, eventName, eventTime, mode, occurrenceKey = null },
) {
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
  const baseEventId = `crm:${lead.id}:${eventName.replaceAll(' ', '_').toLowerCase()}:${datasetKey}:${mode}`;
  const existingBase = await client.query(
    'SELECT * FROM meta_conversion_events WHERE event_id = $1 AND tenant_id = $2',
    [baseEventId, lead.tenant_id],
  );
  if (existingBase.rows[0] && existingBase.rows[0].validity_status !== 'INVALIDATED') {
    return existingBase.rows[0];
  }
  const occurrence = crypto.createHash('sha256')
    .update(
      occurrenceKey
        ? String(occurrenceKey)
        : `${lead.id}:${eventName}:${datasetKey}:${mode}:${new Date(eventTime || Date.now()).toISOString()}`,
    )
    .digest('hex')
    .slice(0, 24);
  const eventId = `${baseEventId}:occ:${occurrence}`;
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

async function recordInternalTestMetaBlock(client, lead, {
  eventName = null,
  source = 'CRM',
  eventId = null,
} = {}) {
  await client.query(
    `INSERT INTO lead_stage_history (
       tenant_id, lead_id, previous_stage, new_stage, origin,
       observation, activity_type, metadata
     ) VALUES ($1,$2,$3,$3,'SYSTEM',$4,'META_EVENT_BLOCKED_INTERNAL_TEST',$5)`,
    [
      lead.tenant_id,
      lead.id,
      lead.stage,
      'META_EVENT_BLOCKED_INTERNAL_TEST',
      { eventName, source, eventId },
    ],
  );
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

export async function createMetaCleanCanaryEvent({
  leadId,
  datasetId = META_CLEAN_DATASET_ID,
  eventTime,
  confirmationId,
  dryRun = false,
} = {}) {
  const safeLeadId = String(leadId || '').trim();
  const safeDatasetId = String(datasetId || '').trim();
  const safeConfirmationId = String(confirmationId || '').trim();
  const observedAt = new Date(eventTime);
  if (!safeLeadId) throw new Error('META_CLEAN_LEAD_ID_REQUIRED');
  if (safeDatasetId !== META_CLEAN_DATASET_ID || safeDatasetId === META_LEGACY_DATASET_ID) {
    throw new Error('META_CLEAN_DATASET_INVALID');
  }
  if (!safeConfirmationId) throw new Error('META_CLEAN_CONFIRMATION_REQUIRED');
  if (!Number.isFinite(observedAt.getTime())) throw new Error('META_CLEAN_EVENT_TIME_INVALID');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM leads
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId(), safeLeadId],
    );
    const lead = selected.rows[0];
    if (!lead) throw new Error('META_CLEAN_LEAD_NOT_FOUND');
    if (lead.is_internal_test === true) throw new Error('META_CLEAN_INTERNAL_TEST_BLOCKED');
    if (lead.meta_outbound_eligible !== true) throw new Error('META_CLEAN_LEAD_NOT_ELIGIBLE');
    if (!lead.meta_lead_id) throw new Error('META_CLEAN_META_LEAD_ID_MISSING');
    if (lead.stage !== 'QUALIFIED') throw new Error('META_CLEAN_STAGE_INVALID');
    if (lead.stage_source !== 'WHATSAPP_LABEL') throw new Error('META_CLEAN_STAGE_SOURCE_INVALID');
    if (lead.stage_verification_status !== 'VERIFIED') throw new Error('META_CLEAN_STAGE_NOT_VERIFIED');
    const datasetResult = await client.query(
      `SELECT dataset.id AS clean_meta_dataset_id,
              dataset.dataset_id AS clean_dataset_value,
              dataset.meta_connection_id AS clean_meta_connection_id,
              dataset.active AS clean_dataset_active,
              connection.status AS clean_connection_status,
              connection.active AS clean_connection_active
       FROM meta_datasets dataset
       JOIN meta_connections connection
         ON connection.tenant_id = dataset.tenant_id
        AND connection.id = dataset.meta_connection_id
       WHERE dataset.tenant_id = $1 AND dataset.dataset_id = $2
       LIMIT 1`,
      [tenantId(), safeDatasetId],
    );
    const dataset = datasetResult.rows[0];
    if (
      !dataset?.clean_meta_dataset_id ||
      dataset.clean_dataset_value !== safeDatasetId ||
      dataset.clean_dataset_active !== true ||
      dataset.clean_connection_active !== true ||
      dataset.clean_connection_status !== 'VALID' ||
      lead.meta_connection_id !== dataset.clean_meta_connection_id
    ) {
      throw new Error('META_CLEAN_DATASET_NOT_ACTIVE_FOR_LEAD');
    }

    const confirmation = await client.query(
      `SELECT * FROM wa2_current_label_confirmations
       WHERE tenant_id = $1 AND id = $2 AND lead_id = $3
         AND result = 'STAGE_ALIGNED'
         AND resulting_stage = 'QUALIFIED'
       FOR SHARE`,
      [tenantId(), safeConfirmationId, safeLeadId],
    );
    if (!confirmation.rows[0]) throw new Error('META_CLEAN_CONFIRMATION_NOT_FOUND');
    if (new Date(confirmation.rows[0].observed_at).getTime() !== observedAt.getTime()) {
      throw new Error('META_CLEAN_CONFIRMATION_TIME_MISMATCH');
    }

    const validMql = await client.query(
      `SELECT id FROM meta_conversion_events
       WHERE tenant_id = $1 AND lead_id = $2
         AND event_name = 'Marketing Qualified Lead'
         AND validity_status = 'VALID'
       LIMIT 1`,
      [tenantId(), safeLeadId],
    );
    if (validMql.rows[0]) throw new Error('META_CLEAN_VALID_MQL_ALREADY_EXISTS');

    if (dryRun) {
      await client.query('ROLLBACK');
      return {
        dryRun: true,
        writes: 0,
        event: null,
        job: null,
        confirmation,
      };
    }

    const event = await createOrGetMetaEvent(client, {
      lead: {
        ...lead,
        meta_connection_id: dataset.clean_meta_connection_id,
        dataset_id: safeDatasetId,
      },
      eventName: 'Marketing Qualified Lead',
      eventTime: observedAt,
      mode: 'live',
      occurrenceKey: `meta-clean-canary:${safeConfirmationId}:${safeDatasetId}:${safeLeadId}:mql:v1`,
    });
    if (!event) throw new Error('META_CLEAN_EVENT_NOT_CREATED');
    const jobCreated = await enqueueConversionJob(client, event);
    const jobResult = await client.query(
      `SELECT * FROM meta_jobs
       WHERE tenant_id = $1 AND dedupe_key = $2
       LIMIT 1`,
      [tenantId(), `conversion:${event.event_id}`],
    );
    await client.query('COMMIT');
    return {
      dryRun: false,
      writes: (event.status === 'PENDING' ? 1 : 0) + (jobCreated ? 1 : 0),
      event,
      job: jobResult.rows[0] || null,
      jobCreated,
      confirmation: confirmation.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const HISTORICAL_MQL_STAGES = [
  'QUALIFIED',
  'NEGOTIATING',
  'OPPORTUNITY',
  'AWAITING_ENROLLMENT',
  'AWAITING_PAYMENT',
];

function historicalMqlRouteSql(alias = 'lead', connectionAlias = 'connection') {
  return `(
    ${alias}.business_id = '4589264227835647'
    OR (
      ${alias}.meta_page_id = '1119504964569694'
      AND ${alias}.meta_form_id = '1760211795329890'
    )
    OR ${connectionAlias}.business_id = '4589264227835647'
  )`;
}

async function selectMetaCleanHistoricalCandidate(client, {
  historicalEventId,
  leadId,
  datasetId,
  cutoff,
}) {
  const result = await client.query(
    `SELECT event.id AS historical_event_id,
            event.event_id AS historical_event_key,
            event.event_time AS historical_event_time,
            lead.*,
            connection.business_id AS connection_business_id,
            (SELECT count(*)
             FROM wa2_contact_links link
             WHERE link.tenant_id = lead.tenant_id
               AND link.lead_id = lead.id
               AND link.unlinked_at IS NULL) AS active_link_count,
            (SELECT count(*)
             FROM lead_verified_whatsapp_identities identity
             WHERE identity.tenant_id = lead.tenant_id
               AND identity.lead_id = lead.id
               AND identity.verified = true) AS verified_identity_count,
            (SELECT count(DISTINCT receipt.remote_label_id)
             FROM wa2_contact_links link
             JOIN wa2_instances instance
               ON instance.tenant_id = link.tenant_id
              AND instance.id = link.wa2_instance_id
              AND instance.enabled = true
             JOIN wa2_label_event_receipts receipt
               ON receipt.tenant_id = link.tenant_id
              AND receipt.remote_instance_id = instance.remote_instance_id
              AND receipt.remote_chat_id = link.remote_chat_id
              AND receipt.operation = 'APPLY'
             JOIN wa2_label_bindings binding
               ON binding.tenant_id = receipt.tenant_id
              AND binding.wa2_instance_id = link.wa2_instance_id
              AND binding.remote_label_id = receipt.remote_label_id
              AND binding.enabled = true
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
               )) AS current_official_label_count
     FROM meta_conversion_events event
     JOIN leads lead
       ON lead.tenant_id = event.tenant_id
      AND lead.id = event.lead_id
     LEFT JOIN meta_connections connection
       ON connection.tenant_id = event.tenant_id
      AND connection.id = event.meta_connection_id
     WHERE event.tenant_id = $1
       AND event.id = $2
       AND event.lead_id = $3
       AND event.event_name = 'Marketing Qualified Lead'
       AND event.validity_status = 'VALID'
       AND event.event_time >= $4
       AND lead.stage = ANY($5::text[])
       AND lead.stage_source = 'WHATSAPP_LABEL'
       AND lead.stage_verification_status = 'VERIFIED'
       AND lead.meta_lead_id IS NOT NULL
       AND lead.meta_outbound_eligible = true
       AND lead.is_internal_test = false
       AND ${historicalMqlRouteSql()}
     FOR UPDATE OF event, lead` ,
    [tenantId(), historicalEventId, leadId, cutoff, HISTORICAL_MQL_STAGES],
  );
  const candidate = result.rows[0] || null;
  if (!candidate) throw new Error('META_CLEAN_HISTORICAL_CANDIDATE_INVALID');
  if (Number(candidate.active_link_count) !== 1) throw new Error('META_CLEAN_HISTORICAL_LINK_INVALID');
  if (
    Number(candidate.verified_identity_count) !== 1
    && Number(candidate.current_official_label_count) !== 1
  ) {
    throw new Error('META_CLEAN_HISTORICAL_IDENTITY_INVALID');
  }
  if (Number(candidate.current_official_label_count) !== 1) {
    throw new Error('META_CLEAN_HISTORICAL_LABEL_AMBIGUOUS');
  }
  const existing = await client.query(
    `SELECT event.id
     FROM meta_conversion_events event
     JOIN meta_datasets dataset
       ON dataset.tenant_id = event.tenant_id
      AND dataset.id = event.meta_dataset_id
     WHERE event.tenant_id = $1
       AND event.lead_id = $2
       AND event.event_name = 'Marketing Qualified Lead'
       AND event.validity_status = 'VALID'
       AND dataset.dataset_id = $3
     LIMIT 1`,
    [tenantId(), leadId, datasetId],
  );
  if (existing.rows[0]) throw new Error('META_CLEAN_HISTORICAL_ALREADY_SENT');
  return candidate;
}

export async function listMetaCleanHistoricalCandidates({
  datasetId = META_CLEAN_DATASET_ID,
  cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  limit = 25,
} = {}) {
  const safeDatasetId = String(datasetId || '').trim();
  if (safeDatasetId !== META_CLEAN_DATASET_ID) throw new Error('META_CLEAN_DATASET_INVALID');
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 25);
  const client = await pool.connect();
  try {
    const candidates = await client.query(
      `SELECT event.id AS historical_event_id,
              event.event_id AS historical_event_key,
              event.lead_id,
              event.event_time,
              lead.stage
       FROM meta_conversion_events event
       JOIN leads lead
         ON lead.tenant_id = event.tenant_id
        AND lead.id = event.lead_id
       LEFT JOIN meta_connections connection
         ON connection.tenant_id = event.tenant_id
        AND connection.id = event.meta_connection_id
       WHERE event.tenant_id = $1
         AND event.event_name = 'Marketing Qualified Lead'
         AND event.validity_status = 'VALID'
         AND event.event_time >= $2
         AND lead.stage = ANY($3::text[])
         AND lead.stage_source = 'WHATSAPP_LABEL'
         AND lead.stage_verification_status = 'VERIFIED'
         AND lead.meta_lead_id IS NOT NULL
         AND lead.meta_outbound_eligible = true
         AND lead.is_internal_test = false
         AND ${historicalMqlRouteSql()}
         AND NOT EXISTS (
           SELECT 1
           FROM meta_conversion_events newer
           JOIN meta_datasets dataset
             ON dataset.tenant_id = newer.tenant_id
            AND dataset.id = newer.meta_dataset_id
           WHERE newer.tenant_id = event.tenant_id
             AND newer.lead_id = event.lead_id
             AND newer.event_name = 'Marketing Qualified Lead'
             AND newer.validity_status = 'VALID'
             AND dataset.dataset_id = $4
         )
         AND (
           SELECT count(*)
           FROM wa2_contact_links link
           WHERE link.tenant_id = lead.tenant_id
             AND link.lead_id = lead.id
             AND link.unlinked_at IS NULL
         ) = 1
         AND (
           SELECT count(DISTINCT receipt.remote_label_id)
           FROM wa2_contact_links link
           JOIN wa2_instances instance
             ON instance.tenant_id = link.tenant_id
            AND instance.id = link.wa2_instance_id
            AND instance.enabled = true
           JOIN wa2_label_event_receipts receipt
             ON receipt.tenant_id = link.tenant_id
            AND receipt.remote_instance_id = instance.remote_instance_id
            AND receipt.remote_chat_id = link.remote_chat_id
            AND receipt.operation = 'APPLY'
           JOIN wa2_label_bindings binding
             ON binding.tenant_id = receipt.tenant_id
            AND binding.wa2_instance_id = link.wa2_instance_id
            AND binding.remote_label_id = receipt.remote_label_id
            AND binding.enabled = true
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
         ) = 1
       ORDER BY event.event_time, event.lead_id
       LIMIT $5`,
      [tenantId(), cutoff, HISTORICAL_MQL_STAGES, safeDatasetId, safeLimit],
    );
    return candidates.rows;
  } finally {
    client.release();
  }
}

export async function createMetaCleanHistoricalBatch({
  candidates = [],
  datasetId = META_CLEAN_DATASET_ID,
  cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  dryRun = true,
} = {}) {
  const safeDatasetId = String(datasetId || '').trim();
  if (safeDatasetId !== META_CLEAN_DATASET_ID) throw new Error('META_CLEAN_DATASET_INVALID');
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 25) {
    throw new Error('META_CLEAN_HISTORICAL_BATCH_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const datasetResult = await client.query(
      `SELECT dataset.id AS clean_meta_dataset_id,
              dataset.dataset_id AS clean_dataset_value,
              dataset.meta_connection_id AS clean_meta_connection_id,
              dataset.active AS clean_dataset_active,
              connection.status AS clean_connection_status,
              connection.active AS clean_connection_active
       FROM meta_datasets dataset
       JOIN meta_connections connection
         ON connection.tenant_id = dataset.tenant_id
        AND connection.id = dataset.meta_connection_id
       WHERE dataset.tenant_id = $1 AND dataset.dataset_id = $2
       LIMIT 1`,
      [tenantId(), safeDatasetId],
    );
    const dataset = datasetResult.rows[0];
    if (
      !dataset
      || dataset.clean_dataset_value !== safeDatasetId
      || dataset.clean_dataset_active !== true
      || dataset.clean_connection_active !== true
      || dataset.clean_connection_status !== 'VALID'
    ) throw new Error('META_CLEAN_DATASET_NOT_ACTIVE');
    const created = [];
    for (const item of candidates) {
      const candidate = await selectMetaCleanHistoricalCandidate(client, {
        historicalEventId: item.historical_event_id,
        leadId: item.lead_id,
        datasetId: safeDatasetId,
        cutoff,
      });
      const event = await createOrGetMetaEvent(client, {
        lead: {
          ...candidate,
          meta_connection_id: dataset.clean_meta_connection_id,
          dataset_id: safeDatasetId,
        },
        eventName: 'Marketing Qualified Lead',
        eventTime: candidate.historical_event_time,
        mode: 'live',
        occurrenceKey: `meta-clean-historical:${candidate.historical_event_id}:${safeDatasetId}:mql:v1`,
      });
      if (!event) throw new Error('META_CLEAN_HISTORICAL_EVENT_NOT_CREATED');
      const jobCreated = await enqueueConversionJob(client, event);
      created.push({ event, jobCreated });
    }
    if (dryRun) {
      await client.query('ROLLBACK');
      return { dryRun: true, writes: 0, events: created.length, jobs: 0, created };
    }
    await client.query('COMMIT');
    return {
      dryRun: false,
      writes: created.length,
      events: created.length,
      jobs: created.filter((item) => item.jobCreated).length,
      created,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMetaEventForStage(
  client,
  { lead, stage, eventTime, mode, officialLabelEvidence = false },
) {
  const sequenceSkipped = ['NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].includes(stage);
  if (isInternalTestLead(lead)) {
    await recordInternalTestMetaBlock(client, lead, {
      eventName: getStageEventName(stage),
      source: 'STAGE_FLOW',
    });
    return {
      event: null,
      jobCreated: false,
      reason: 'META_EVENT_BLOCKED_INTERNAL_TEST',
      sequenceSkipped,
    };
  }
  if (process.env.META_CAPI_OUTBOUND_ENABLED !== 'true') {
    return { event: null, jobCreated: false, reason: 'META_OUTBOUND_DISABLED', sequenceSkipped };
  }
  if (!isMetaOutboundEligibleByStageTruth(lead)) {
    return {
      event: null,
      jobCreated: false,
      reason: 'STAGE_NOT_WHATSAPP_VERIFIED',
      sequenceSkipped,
    };
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
      metaReason,
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

function assertManualStageTarget(stage) {
  if (!isKnownStage(stage) || isProtectedCommercialStage(stage)) {
    throw new Error('MANUAL_STAGE_TARGET_INVALID');
  }
}

export async function createManualStageChangeRequest({
  leadId,
  requestedStage,
  requestedBy,
  mandatoryReason,
  metadata = {},
}) {
  assertManualStageTarget(requestedStage);
  const actor = safeActor(requestedBy);
  const reason = String(mandatoryReason || '').trim().slice(0, 1000);
  if (!actor) throw new Error('MANUAL_STAGE_ACTOR_REQUIRED');
  if (reason.length < 5) throw new Error('MANUAL_STAGE_REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), leadId],
    );
    const lead = selected.rows[0];
    if (!lead) throw new Error('LEAD_NOT_FOUND');
    if (lead.stage === requestedStage) throw new Error('MANUAL_STAGE_ALREADY_CURRENT');
    const pending = await client.query(
      `SELECT id FROM manual_stage_change_requests
       WHERE tenant_id = $1 AND lead_id = $2
         AND status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_WA', 'PENDING_WA_LINK')
       LIMIT 1`,
      [tenantId(), leadId],
    );
    if (pending.rows[0]) throw new Error('MANUAL_STAGE_REQUEST_PENDING');
    const inserted = await client.query(
      `INSERT INTO manual_stage_change_requests (
         tenant_id, lead_id, current_stage, requested_stage,
         requested_by, mandatory_reason, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [tenantId(), leadId, lead.stage, requestedStage, actor, reason, {
        ...metadata,
        source: 'CRM_MANUAL_STAGE_REQUEST',
      }],
    );
    const request = inserted.rows[0];
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         changed_by, observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'MANUAL',$4,$5,'MANUAL_STAGE_REQUESTED',$6)`,
      [
        tenantId(), leadId, lead.stage, actor,
        'Solicitação de mudança criada; aguardando aprovação e confirmação WA2.',
        { requestId: request.id, requestedStage, reason },
      ],
    );
    await client.query('COMMIT');
    return request;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listManualStageRequestsForLead(leadId) {
  const result = await pool.query(
    `SELECT * FROM manual_stage_change_requests
     WHERE tenant_id = $1 AND lead_id = $2
     ORDER BY created_at DESC`,
    [tenantId(), leadId],
  );
  return result.rows;
}

export async function approveManualStageChangeRequest({
  requestId,
  actor,
  emergencyOverride = false,
  confirmation = '',
  emergencyReason = '',
}) {
  const safeApprover = safeActor(actor);
  if (!safeApprover) throw new Error('MANUAL_STAGE_APPROVER_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT request.*, lead.*,
              request.id AS request_id, request.status AS request_status,
              request.current_stage AS request_current_stage,
              request.requested_stage AS request_requested_stage
       FROM manual_stage_change_requests request
       JOIN leads lead ON lead.tenant_id = request.tenant_id AND lead.id = request.lead_id
       WHERE request.tenant_id = $1 AND request.id = $2
       FOR UPDATE OF request, lead`,
      [tenantId(), requestId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error('MANUAL_STAGE_REQUEST_NOT_FOUND');
    if (row.request_status !== MANUAL_STAGE_REQUEST_STATUSES.PENDING_APPROVAL) {
      throw new Error('MANUAL_STAGE_REQUEST_NOT_PENDING');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE manual_stage_change_requests SET status = 'EXPIRED', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), requestId],
      );
      throw new Error('MANUAL_STAGE_REQUEST_EXPIRED');
    }
    const sameActor = row.requested_by === safeApprover;
    if (sameActor && !emergencyOverride) throw new Error('MANUAL_STAGE_SELF_APPROVAL');
    if (sameActor && emergencyOverride && confirmation !== 'APPROVE_EMERGENCY_STAGE_CHANGE') {
      throw new Error('MANUAL_STAGE_EMERGENCY_CONFIRMATION_REQUIRED');
    }
    if (sameActor && emergencyOverride && String(emergencyReason || '').trim().length < 20) {
      throw new Error('MANUAL_STAGE_EMERGENCY_REASON_REQUIRED');
    }
    assertManualStageTarget(row.request_requested_stage);
    const history = await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         changed_by, observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'MANUAL',$4,$5,'MANUAL_STAGE_APPROVED',$6)
       RETURNING id`,
      [
        tenantId(), row.lead_id, row.request_current_stage, safeApprover,
        'Solicitação aprovada; aguardando receipt oficial da etiqueta WA2.',
        {
          requestId, requestedStage: row.request_requested_stage,
          emergencyOverride: Boolean(emergencyOverride),
          emergencyReason: sameActor ? String(emergencyReason).trim().slice(0, 1000) : null,
        },
      ],
    );
    const link = await client.query(
      `SELECT link.* FROM wa2_contact_links link
       JOIN wa2_instances instance
         ON instance.tenant_id = link.tenant_id AND instance.id = link.wa2_instance_id
       WHERE link.tenant_id = $1 AND link.lead_id = $2
         AND link.unlinked_at IS NULL AND instance.enabled = true
       ORDER BY instance.is_default DESC, link.created_at DESC
       FOR UPDATE`,
      [tenantId(), row.lead_id],
    );
    if (link.rowCount !== 1) {
      await client.query(
        `UPDATE manual_stage_change_requests
         SET status = 'PENDING_WA_LINK', approved_by = $3, approved_at = now(),
             emergency_override = $4, updated_at = now(),
             metadata = metadata || $5::jsonb
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), requestId, safeApprover, Boolean(emergencyOverride), JSON.stringify({ approvalHistoryId: history.rows[0].id })],
      );
      await client.query(
        `UPDATE leads SET stage_source = 'MANUAL_TWO_STEP_APPROVED',
           stage_verification_status = 'PENDING_WA_LABEL', updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), row.lead_id],
      );
      await client.query('COMMIT');
      return { requestId, status: 'PENDING_WA_LINK', scheduled: 0 };
    }
    const clonedLead = { ...row, id: row.lead_id, stage: row.request_requested_stage };
    const sync = await enqueueWa2LabelJobs(client, {
      lead: clonedLead,
      previousStage: row.request_current_stage,
      stageHistoryId: history.rows[0].id,
    });
    await client.query(
      `UPDATE manual_stage_change_requests
       SET status = 'APPROVED_PENDING_WA', approved_by = $3, approved_at = now(),
           emergency_override = $4, updated_at = now(),
           metadata = metadata || $5::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), requestId, safeApprover, Boolean(emergencyOverride), JSON.stringify({ approvalHistoryId: history.rows[0].id, wa2Scheduled: sync.scheduled })],
    );
    await client.query(
      `UPDATE leads SET stage_source = 'MANUAL_TWO_STEP_APPROVED',
         stage_verification_status = 'PENDING_WA_LABEL', updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), row.lead_id],
    );
    await client.query('COMMIT');
    return { requestId, status: 'APPROVED_PENDING_WA', scheduled: sync.scheduled, syncReason: sync.reason };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectManualStageChangeRequest({ requestId, actor, reason }) {
  const safeApprover = safeActor(actor);
  const safeReason = String(reason || '').trim().slice(0, 1000);
  if (!safeApprover) throw new Error('MANUAL_STAGE_APPROVER_REQUIRED');
  if (safeReason.length < 5) throw new Error('MANUAL_STAGE_REJECTION_REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      `SELECT * FROM manual_stage_change_requests
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), requestId],
    );
    const request = selected.rows[0];
    if (!request) throw new Error('MANUAL_STAGE_REQUEST_NOT_FOUND');
    if (request.status !== MANUAL_STAGE_REQUEST_STATUSES.PENDING_APPROVAL) {
      throw new Error('MANUAL_STAGE_REQUEST_NOT_PENDING');
    }
    await client.query(
      `UPDATE manual_stage_change_requests
       SET status = 'REJECTED', rejected_by = $3, rejected_at = now(), updated_at = now(),
           metadata = metadata || $4::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), requestId, safeApprover, JSON.stringify({ rejectionReason: safeReason })],
    );
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         changed_by, observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'MANUAL',$4,$5,'MANUAL_STAGE_REJECTED',$6)`,
      [tenantId(), request.lead_id, request.current_stage, safeApprover, safeReason, { requestId }],
    );
    await client.query('COMMIT');
    return { requestId, status: 'REJECTED' };
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
  if (execute || process.env.META_CLEAN_HISTORICAL_BACKFILL !== 'true') {
    return {
      selected: 0,
      created: 0,
      queued: 0,
      leads: [],
      blocked: 'META_HISTORICAL_BACKFILL_DISABLED',
    };
  }
  const limit = Math.max(1, Math.min(Number(batchSize) || 50, 500));
  const candidates = await pool.query(
    `SELECT lead.*
     FROM leads lead
     WHERE lead.tenant_id = $1
       AND lead.stage IN ('QUALIFIED', 'NEGOTIATING', 'OPPORTUNITY',
                          'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT')
       AND lead.meta_lead_id IS NOT NULL
       AND lead.is_internal_test = false
       AND lead.meta_outbound_eligible = true
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
  const where = ['tenant_id = $1', 'is_internal_test = false'];
  if (createdAfter) {
    values.push(createdAfter);
    where.push(`COALESCE(received_at, created_at) >= $${values.length}`);
  }
  const [result, queue] = await Promise.all([pool.query(`
    WITH scoped AS (
      SELECT leads.*,
        (SELECT count(*)::int FROM wa2_contact_links link
         WHERE link.tenant_id = leads.tenant_id AND link.lead_id = leads.id
           AND link.unlinked_at IS NULL) AS active_link_count
      FROM leads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE stage = 'NEW')::int AS new,
      count(*) FILTER (WHERE stage = 'NEW' AND first_contact_at IS NULL)::int AS unattended,
      count(*) FILTER (WHERE stage = 'NO_RESPONSE')::int AS no_response,
      count(*) FILTER (WHERE stage = 'QUALIFIED')::int AS qualified,
      count(*) FILTER (WHERE stage IN ('CONTACT_STARTED', 'IN_SERVICE'))::int AS in_service,
      count(*) FILTER (WHERE stage IN ('OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'))::int AS opportunities,
      count(*) FILTER (WHERE stage = 'AWAITING_ENROLLMENT')::int AS awaiting_enrollment,
      count(*) FILTER (WHERE stage = 'AWAITING_PAYMENT')::int AS awaiting_payment,
      count(*) FILTER (WHERE stage = 'ENROLLED')::int AS enrolled,
      count(*) FILTER (WHERE stage = 'PAID')::int AS paid,
      count(*) FILTER (WHERE stage IN ('LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'))::int AS lost,
      count(*) FILTER (WHERE meta_lead_id IS NOT NULL)::int AS attributed,
      count(*) FILTER (WHERE import_phone_status IN ('PHONE_INVALID', 'PHONE_MISSING')
        OR COALESCE(phone_normalized, whatsapp_normalized) IS NULL)::int AS phone_invalid_or_missing,
      count(*) FILTER (WHERE import_phone_status = 'POSSIBLE_PHONE_DUPLICATE')::int AS possible_phone_duplicate,
      count(*) FILTER (WHERE active_link_count > 1)::int AS multiple_active_wa_links,
      count(*) FILTER (WHERE stage_verification_status IN ('PENDING_WA_LABEL', 'UNVERIFIED_LEGACY'))::int AS pending_identity,
      count(*) FILTER (WHERE awaiting_manual_reclassification = true)::int AS awaiting_manual_reclassification,
      count(*) FILTER (WHERE awaiting_manual_reclassification = true
        AND COALESCE(import_phone_status, '') NOT IN ('PHONE_INVALID', 'PHONE_MISSING', 'POSSIBLE_PHONE_DUPLICATE')
        AND COALESCE(phone_normalized, whatsapp_normalized) IS NOT NULL
        AND active_link_count = 0)::int AS ready_for_first_link,
      count(*) FILTER (WHERE routing_source = 'ROUTING_PENDING')::int AS routing_pending,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM meta_conversion_events event
        WHERE event.tenant_id = scoped.tenant_id AND event.lead_id = scoped.id
          AND event.event_name = 'Marketing Qualified Lead' AND event.validity_status = 'VALID'
      ))::int AS mql_already_valid
    FROM scoped
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
    reviewQueues: {
      PHONE_INVALID_OR_MISSING: counts.phone_invalid_or_missing,
      POSSIBLE_PHONE_DUPLICATE: counts.possible_phone_duplicate,
      MULTIPLE_ACTIVE_WA_LINKS: counts.multiple_active_wa_links,
      PENDING_IDENTITY: counts.pending_identity,
      AWAITING_MANUAL_RECLASSIFICATION: counts.awaiting_manual_reclassification,
      READY_FOR_FIRST_LINK: counts.ready_for_first_link,
      ROUTING_PENDING: counts.routing_pending,
      MQL_ALREADY_VALID: counts.mql_already_valid,
    },
  };
}

function firstLinkDiagnosticState(row) {
  if (!row?.evidence_id) return 'WAITING_FOR_NEW_LABEL';
  const code = String(row.detail_code || '');
  if (['MULTIPLE_LEAD_MATCHES', 'LEAD_PHONE_MULTIPLE', 'CHAT_LINK_MULTIPLE'].includes(code)) return 'MULTIPLE_LEAD_MATCHES';
  if (code.includes('IDENTITY_CONFLICT') || code.includes('WA_IDENTITY')) return 'WA_IDENTITY_CONFLICT';
  if (['NO_MATCH', 'CHAT_LINK_NOT_FOUND', 'LEAD_PHONE_NOT_FOUND', 'LID_UNRESOLVED'].includes(code)) return 'NO_MATCH';
  if (row.action === 'CONFLICT') return 'BLOCKED';
  if (row.mql_status === 'SENT' && row.mql_validity === 'VALID') return 'MQL_SENT';
  if (row.mql_validity === 'VALID') return 'MQL_ALREADY_VALID';
  if (row.action === 'STAGE_CHANGED') return 'STAGE_UPDATED';
  if (Number(row.verified_identity_count) === 1) return 'IDENTITY_VERIFIED';
  if (Number(row.active_link_count) === 1) return 'LINK_CREATED';
  return 'EXACT_SINGLE_MATCH';
}

export async function getFirstLinkDiagnostic() {
  const result = await pool.query(`
    WITH armed AS (
      SELECT lead.*
      FROM leads lead
      WHERE lead.tenant_id = $1 AND lead.awaiting_manual_reclassification = true
        AND lead.reclassification_armed_at IS NOT NULL
      ORDER BY lead.reclassification_armed_at, lead.id
      LIMIT 1
    )
    SELECT armed.id, armed.name, armed.stage, armed.dataset_id,
      armed.phone_normalized AS lead_phone_normalized,
      armed.reclassification_armed_at,
      evidence.id AS evidence_id, evidence.remote_label_id,
      evidence.remote_label_name, evidence.observed_at,
      evidence.phone_normalized AS evidence_phone_normalized,
      evidence.action, evidence.detail_code, evidence.lead_id AS evidence_lead_id,
      COALESCE(active_links.count, 0)::int AS active_link_count,
      COALESCE(identities.count, 0)::int AS verified_identity_count,
      mql.status AS mql_status, mql.validity_status AS mql_validity
    FROM armed
    LEFT JOIN LATERAL (
      SELECT receipt.id, receipt.remote_label_id, receipt.remote_label_name,
        receipt.observed_at, receipt.phone_normalized,
        action.action, action.detail_code, action.lead_id
      FROM wa2_label_event_receipts receipt
      LEFT JOIN wa2_inbound_label_actions action
        ON action.tenant_id = receipt.tenant_id AND action.receipt_id = receipt.id
      WHERE receipt.tenant_id = armed.tenant_id
        AND receipt.operation = 'APPLY' AND receipt.source = 'WHATSAPP'
        AND receipt.observed_at > armed.reclassification_armed_at
      ORDER BY receipt.observed_at DESC, receipt.received_at DESC, receipt.id DESC
      LIMIT 1
    ) evidence ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count FROM wa2_contact_links link
      WHERE link.tenant_id = armed.tenant_id AND link.lead_id = armed.id
        AND link.unlinked_at IS NULL
    ) active_links ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS count FROM lead_verified_whatsapp_identities identity
      WHERE identity.tenant_id = armed.tenant_id AND identity.lead_id = armed.id
        AND identity.verified = true
    ) identities ON true
    LEFT JOIN LATERAL (
      SELECT event.status, event.validity_status
      FROM meta_conversion_events event
      WHERE event.tenant_id = armed.tenant_id AND event.lead_id = armed.id
        AND event.event_name = 'Marketing Qualified Lead'
      ORDER BY event.updated_at DESC, event.created_at DESC
      LIMIT 1
    ) mql ON true
  `, [tenantId()]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    state: firstLinkDiagnosticState(row),
    leadPhonePresent: Boolean(row.lead_phone_normalized),
    evidencePhonePresent: Boolean(row.evidence_phone_normalized),
    phoneMatch: Boolean(row.evidence_phone_normalized && row.lead_phone_normalized === row.evidence_phone_normalized),
  };
}

export async function claimNextJob() {
  const result = await pool.query(`
    WITH candidate AS (
      SELECT id
      FROM meta_jobs
      WHERE tenant_id = $1
        AND (
          job_type <> 'CONVERSION'
          OR (
            $2 = 'true'
            AND NOT EXISTS (
              SELECT 1
              FROM meta_conversion_events blocked_event
              JOIN leads blocked_lead
                ON blocked_lead.tenant_id = blocked_event.tenant_id
               AND blocked_lead.id = blocked_event.lead_id
              WHERE blocked_event.tenant_id = meta_jobs.tenant_id
                AND blocked_event.id = CASE
                  WHEN meta_jobs.job_type = 'CONVERSION' THEN (meta_jobs.payload->>'eventId')::uuid
                  ELSE NULL
                END
                AND blocked_event.validity_status = 'VALID'
                AND blocked_lead.stage_source = 'WHATSAPP_LABEL'
                AND blocked_lead.stage_verification_status = 'VERIFIED'
                AND (blocked_lead.is_internal_test = true OR blocked_lead.meta_outbound_eligible = false)
            )
          )
        )
        AND ((
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

export async function blockMetaConversionJob(jobId, eventId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE meta_jobs
       SET status = 'FAILED', last_error = 'META_EVENT_BLOCKED_INTERNAL_TEST',
           locked_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND job_type = 'CONVERSION'
       RETURNING id`,
      [jobId, tenantId()],
    );
    if (updated.rowCount) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, meta_event_id, metadata
         )
         SELECT lead.tenant_id, lead.id, lead.stage, lead.stage, 'SYSTEM',
                'Evento Meta bloqueado: lead marcado como INTERNAL_TEST.',
                'META_EVENT_BLOCKED_INTERNAL_TEST', event.id,
                jsonb_build_object('eventId', event.event_id, 'source', 'WORKER')
         FROM meta_conversion_events event
         JOIN leads lead
           ON lead.tenant_id = event.tenant_id AND lead.id = event.lead_id
         WHERE event.tenant_id = $2 AND event.id = $3
           AND (lead.is_internal_test = true OR lead.meta_outbound_eligible = false)`,
        [jobId, tenantId(), eventId],
      );
    }
    await client.query('COMMIT');
    return updated.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getMetaEventContext(id) {
  const result = await pool.query(
    `SELECT e.*, l.name, l.email, l.phone, l.phone_normalized, l.meta_lead_id,
            l.is_internal_test, l.meta_outbound_eligible,
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
  const result = await pool.query(
    `UPDATE meta_conversion_events
     SET status = 'PROCESSING', attempts = $2, updated_at = now()
     WHERE id = $1 AND tenant_id = $3 AND status <> 'SENT'
       AND NOT EXISTS (
         SELECT 1 FROM leads blocked_lead
         WHERE blocked_lead.tenant_id = meta_conversion_events.tenant_id
           AND blocked_lead.id = meta_conversion_events.lead_id
           AND (blocked_lead.is_internal_test = true OR blocked_lead.meta_outbound_eligible = false)
       )`,
    [id, attempts, tenantId()],
  );
  return result.rowCount === 1;
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
         AND NOT EXISTS (
           SELECT 1 FROM leads blocked_lead
           WHERE blocked_lead.tenant_id = meta_conversion_events.tenant_id
             AND blocked_lead.id = meta_conversion_events.lead_id
             AND (blocked_lead.is_internal_test = true OR blocked_lead.meta_outbound_eligible = false)
         )
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
      `SELECT job.*, lead.is_internal_test, lead.meta_outbound_eligible,
              event.lead_id AS event_lead_id
       FROM meta_jobs job
       LEFT JOIN meta_conversion_events event
         ON job.job_type = 'CONVERSION'
        AND event.tenant_id = job.tenant_id
        AND event.id = (job.payload->>'eventId')::uuid
       LEFT JOIN leads lead
         ON lead.tenant_id = event.tenant_id AND lead.id = event.lead_id
       WHERE job.id = $1 AND job.tenant_id = $2
       FOR UPDATE OF job`,
      [id, tenantId()],
    );
    const job = selected.rows[0];
    if (!job || job.status !== 'FAILED') {
      await client.query('ROLLBACK');
      return false;
    }

    if (job.job_type === 'CONVERSION'
      && (job.is_internal_test === true || job.meta_outbound_eligible === false)) {
      await client.query(
        `UPDATE meta_jobs
         SET last_error = 'META_EVENT_BLOCKED_INTERNAL_TEST', updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId()],
      );
      if (job.event_lead_id) {
        await client.query(
          `INSERT INTO lead_stage_history (
             tenant_id, lead_id, previous_stage, new_stage, origin,
             observation, activity_type, metadata
           )
           SELECT lead.tenant_id, lead.id, lead.stage, lead.stage, 'SYSTEM',
                  'Retry bloqueado: lead marcado como INTERNAL_TEST.',
                  'META_EVENT_BLOCKED_INTERNAL_TEST',
                  jsonb_build_object('eventId', $1::text, 'source', 'RETRY')
           FROM leads lead
           WHERE lead.tenant_id = $2 AND lead.id = $3`,
          [job.payload?.eventId || null, tenantId(), job.event_lead_id],
        );
      }
      await client.query('COMMIT');
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

export async function getWa2LabelEventCursor() {
  const result = await pool.query(
    'SELECT * FROM wa2_label_event_cursors WHERE tenant_id = $1',
    [tenantId()],
  );
  return result.rows[0] || null;
}

async function resolveSpreadsheetReclassification(client, { instance, event }) {
  if (
    !instance || event.source !== 'WHATSAPP' || event.operation !== 'APPLY' ||
    event.eligibleForCrm !== true || !event.phoneNormalized
  ) return { lead: null, pending: null, conflictCode: null };
  const identity = getBrazilianPhoneIdentity(event.phoneNormalized, { confirmedMobile: true });
  if (!identity.canonicalE164 || !['BR_MOBILE_CANONICAL', 'BR_MOBILE_LEGACY'].includes(identity.classification)) {
    return { lead: null, pending: null, conflictCode: 'PHONE_IDENTITY_UNRESOLVED' };
  }
  const observedAt = new Date(event.observedAt);
  if (!Number.isFinite(observedAt.getTime())) return { lead: null, pending: null, conflictCode: 'OBSERVED_AT_INVALID' };
  const candidatesResult = await client.query(
    `SELECT lead.*
     FROM leads lead
     WHERE lead.tenant_id = $1
       AND lead.awaiting_manual_reclassification = true
       AND lead.reclassification_armed_at IS NOT NULL
       AND lead.reclassification_armed_at < $2
       AND lead.meta_lead_id IS NOT NULL
       AND lead.meta_connection_id IS NOT NULL
       AND lead.dataset_id = $3
       AND lead.is_internal_test = false
       AND lead.meta_outbound_eligible = true
       AND COALESCE(lead.import_phone_status, '') NOT IN ('PHONE_INVALID', 'PHONE_MISSING')
       AND (lead.phone_normalized = ANY($4::text[]) OR lead.whatsapp_normalized = ANY($4::text[]))
     FOR UPDATE` ,
    [tenantId(), observedAt, String(META_CLEAN_DATASET_ID), identity.aliases],
  );
  if (candidatesResult.rowCount === 0) return { lead: null, pending: null, conflictCode: 'NO_MATCH' };
  if (candidatesResult.rowCount !== 1) return { lead: null, pending: null, conflictCode: 'MULTIPLE_LEAD_MATCHES' };
  const lead = candidatesResult.rows[0];
  const otherLeadResult = await client.query(
    `SELECT id FROM leads
     WHERE tenant_id = $1 AND id <> $2
       AND (phone_normalized = ANY($3::text[]) OR whatsapp_normalized = ANY($3::text[]))
     FOR UPDATE`,
    [tenantId(), lead.id, identity.aliases],
  );
  if (otherLeadResult.rowCount > 0) {
    return { lead: null, pending: null, conflictCode: 'MULTIPLE_LEAD_MATCHES' };
  }
  const activeLinks = await client.query(
    `SELECT id FROM wa2_contact_links
     WHERE tenant_id = $1 AND lead_id = $2 AND unlinked_at IS NULL
     FOR UPDATE`,
    [tenantId(), lead.id],
  );
  if (activeLinks.rowCount > 0) return { lead: null, pending: null, conflictCode: 'LEAD_ALREADY_LINKED' };
  const phoneJid = String(event.phoneJid || '').trim().toLowerCase() ||
    (/^\d+@(s\.whatsapp\.net|c\.us)$/i.test(String(event.jid || ''))
      ? String(event.jid).toLowerCase()
      : `${identity.canonicalE164}@s.whatsapp.net`);
  const lidJid = event.lidJid || (/^[a-z0-9._:-]+@lid$/i.test(String(event.jid || '')) ? String(event.jid).toLowerCase() : null);
  const identityConflict = await client.query(
    `SELECT lead_id FROM lead_verified_whatsapp_identities
     WHERE tenant_id = $1 AND wa2_instance_id = $2
       AND (canonical_phone = $3 OR phone_jid = $4 OR ($5::text IS NOT NULL AND lid_jid = $5))
       AND lead_id <> $6
     FOR UPDATE`,
    [tenantId(), instance.id, identity.canonicalE164, phoneJid, lidJid, lead.id],
  );
  if (identityConflict.rowCount > 0) return { lead: null, pending: null, conflictCode: 'WA_IDENTITY_CONFLICT' };
  return {
    lead: { id: lead.id, stage: lead.stage, meta_lead_id: lead.meta_lead_id, awaiting_manual_reclassification: true },
    pending: {
      leadId: lead.id,
      canonicalPhone: identity.canonicalE164,
      sourcePhone: String(event.phoneNormalized),
      observedAt: event.observedAt,
      eventId: event.eventId,
      remoteContactId: event.remoteContactId || phoneJid,
      remoteChatId: event.chatId,
      phoneJid,
      lidJid,
      chatJid: event.chatJid || lidJid || event.jid || null,
    },
    conflictCode: null,
  };
}

async function createSpreadsheetReclassificationLink(client, { instance, pending }) {
  const resolved = {
    contact: { id: pending.remoteContactId, jid: pending.phoneJid, phoneNormalized: pending.canonicalPhone },
    chat: { id: pending.remoteChatId, jid: pending.chatJid },
  };
  await ensureNoActiveWa2LinkConflict(client, {
    leadId: pending.leadId,
    instanceId: instance.id,
    remoteChatId: pending.remoteChatId,
  });
  const link = await insertWa2ContactLink(client, {
    leadId: pending.leadId,
    instanceId: instance.id,
    expectedPhoneNormalized: pending.canonicalPhone,
    resolved,
    actor: 'system:spreadsheet-reclassification',
  });
  const identityReference = deterministicEvidenceReference({
    evidenceType: 'WA2_CONTACT_STATE',
    tenantIdValue: tenantId(),
    instanceId: instance.id,
    chatId: pending.remoteChatId,
    contactId: pending.remoteContactId,
    phoneJid: pending.phoneJid,
    lidJid: pending.lidJid,
    observedAt: new Date(pending.observedAt),
    evidenceReference: pending.eventId,
  });
  const existingIdentity = await client.query(
    `SELECT * FROM lead_verified_whatsapp_identities
     WHERE tenant_id = $1 AND lead_id = $2 AND wa2_instance_id = $3
       AND canonical_phone = $4
     FOR UPDATE`,
    [tenantId(), pending.leadId, instance.id, pending.canonicalPhone],
  );
  if (existingIdentity.rowCount > 0) {
    const current = existingIdentity.rows[0];
    if (
      current.remote_chat_id !== pending.remoteChatId ||
      current.remote_contact_id !== pending.remoteContactId ||
      current.phone_jid !== pending.phoneJid ||
      current.lid_jid !== pending.lidJid
    ) throw new Wa2DataError('Identidade WA2 divergente', 'WA2_IDENTITY_CONFLICT');
  } else {
    await client.query(
      `INSERT INTO lead_verified_whatsapp_identities (
         tenant_id, lead_id, wa2_instance_id, canonical_phone, aliases,
         source_phone, phone_jid, lid_jid, verification_source,
         verification_reason, remote_contact_id, remote_chat_id,
         evidence_wa_message_id, evidence_observed_at, verified_by,
         evidence_type, evidence_reference
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,'WA2_CONTACT_STATE',$15)`,
      [
        tenantId(), pending.leadId, instance.id, pending.canonicalPhone,
        JSON.stringify(getBrazilianPhoneIdentity(pending.canonicalPhone, { confirmedMobile: true }).aliases),
        pending.sourcePhone, pending.phoneJid, pending.lidJid,
        DETERMINISTIC_IDENTITY_SOURCE, 'LABEL_AFTER_SPREADSHEET_ARMING',
        pending.remoteContactId, pending.remoteChatId, new Date(pending.observedAt),
        'system:spreadsheet-reclassification', identityReference,
      ],
    );
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) SELECT tenant_id, id, stage, stage, 'SYSTEM',
         'Identidade WA2 verificada por etiqueta após armamento da importação.',
         'WHATSAPP_IDENTITY_VERIFIED', $3
       FROM leads WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), pending.leadId, {
        evidenceType: 'WA2_CONTACT_STATE',
        evidenceReference: identityReference,
        remoteChatId: pending.remoteChatId,
        remoteContactId: pending.remoteContactId,
      }],
    );
  }
  await client.query(
    `UPDATE leads SET whatsapp_normalized = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), pending.leadId, pending.canonicalPhone],
  );
  return { link, identity: existingIdentity.rows[0] || null };
}

async function completeManualStageRequestForReceipt(client, {
  leadId,
  targetStage,
  actionId,
  receiptId,
}) {
  const completed = await client.query(
    `UPDATE manual_stage_change_requests
     SET status = 'COMPLETED', updated_at = now(),
         metadata = metadata || jsonb_build_object(
           'completionActionId', $4::text,
           'completionReceiptId', $5::text
         )
     WHERE tenant_id = $1 AND lead_id = $2
       AND requested_stage = $3
       AND status IN ('APPROVED_PENDING_WA', 'PENDING_WA_LINK')
     RETURNING *`,
    [tenantId(), leadId, targetStage, actionId, receiptId],
  );
  for (const request of completed.rows) {
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         changed_by, observation, activity_type, metadata
       ) VALUES ($1,$2,$3,$3,'WHATSAPP',NULL,$4,'MANUAL_STAGE_COMPLETED',$5)`,
      [
        tenantId(), leadId, request.current_stage,
        'Solicitação manual concluída após receipt oficial WA2.',
        { requestId: request.id, actionId, receiptId, requestedStage: targetStage },
      ],
    );
  }
  return completed.rowCount;
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

    let pendingReclassification = null;
    let pendingResolutionConflict = null;
    if (!lead && instance && event.source === 'WHATSAPP' && event.operation === 'APPLY' && event.eligibleForCrm) {
      const resolved = await resolveSpreadsheetReclassification(client, { instance, event });
      pendingReclassification = resolved.pending;
      pendingResolutionConflict = resolved.conflictCode;
      if (resolved.lead) lead = resolved.lead;
    }
    let decision;
    let eventBindingStages = [];
    let currentCrmLabelStages = [];
    let previousLabelObservedAt = null;
    if (event.source === 'WHATSAPP' && event.operation === 'APPLY' && event.eligibleForCrm) {
      if (pendingResolutionConflict) {
        decision = { action: 'CONFLICT', code: pendingResolutionConflict };
      } else if (!instance) {
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
        const currentLabelIds = [...new Set(currentRemoteLabelIds)];
        currentCrmLabelStages = currentLabelIds
          .map((id) => byLabel.get(id))
          .filter(Boolean);
        if (currentCrmLabelStages.length > 1) {
          const previousStageLabelIds = currentLabelIds.filter((labelId) => {
            if (labelId === event.waLabelId) return false;
            const labelStage = canonicalInboundStage(byLabel.get(labelId) || []);
            return labelStage === officialCrmLabelStageFor(lead.stage);
          });
          if (previousStageLabelIds.length > 0) {
            const previousEvent = await client.query(
              `SELECT observed_at
               FROM wa2_label_event_receipts
               WHERE tenant_id = $1
                 AND remote_instance_id = $2
                 AND remote_chat_id = $3
                 AND remote_label_id = ANY($4::text[])
                 AND operation = 'APPLY'
               ORDER BY observed_at DESC, received_at DESC, id DESC
               LIMIT 1`,
              [tenantId(), event.instanceId, event.chatId, previousStageLabelIds],
            );
            previousLabelObservedAt = previousEvent.rows[0]?.observed_at || null;
          }
        }
      }
    }
    decision ||= pendingResolutionConflict
      ? { action: 'CONFLICT', code: pendingResolutionConflict }
      : decideInboundLabelAction({
        event,
        currentStage: lead?.stage,
        eventBindingStages,
        currentCrmLabelStages,
        previousLabelObservedAt,
        eventObservedAt: event.observedAt,
        identityMatch: Boolean((link || pendingReclassification) && instance),
        linkMatch: Boolean((link || pendingReclassification) && instance),
      });
    if (pendingReclassification && ['STAGE_CHANGED', 'NOOP'].includes(decision.action)) {
      link = await createSpreadsheetReclassificationLink(client, {
        instance,
        pending: pendingReclassification,
      });
    }
    const detailCode = {
      LEAD_PHONE_MULTIPLE: 'MULTIPLE_LEAD_MATCHES',
      CHAT_LINK_MULTIPLE: 'MULTIPLE_LEAD_MATCHES',
      WA2_VERIFIED_IDENTITY_CONFLICT: 'IDENTITY_CONFLICT',
      WA2_IDENTITY_USED_BY_ANOTHER_LEAD: 'IDENTITY_CONFLICT',
      UNKNOWN_SOURCE: 'IGNORED_TECHNICAL_EVENT',
    }[decision.code] || decision.code;
    const actionResult = await client.query(
      `INSERT INTO wa2_inbound_label_actions (
         tenant_id, receipt_id, wa2_instance_id, wa2_contact_link_id,
         lead_id, target_stage, action, detail_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        tenantId(), receipt.id, instance?.id || null, link?.id || null,
        lead?.id || null, decision.targetStage || null, decision.action, detailCode,
      ],
    );
    const action = actionResult.rows[0];
    if (pendingReclassification && ['STAGE_CHANGED', 'NOOP'].includes(decision.action)) {
      await client.query(
        `UPDATE wa2_inbound_label_actions SET wa2_contact_link_id = $3
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), action.id, link.id],
      );
      await client.query(
        `UPDATE leads SET awaiting_manual_reclassification = false, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), lead.id],
      );
    }
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
           stage_source = 'WHATSAPP_LABEL',
           source_label_id = $6,
           source_label_name = $7,
           source_action_id = $8,
           source_receipt_id = $9,
           source_observed_at = $10,
           stage_verified_at = now(),
           stage_verification_status = 'VERIFIED',
           lost_reason = CASE WHEN $3 = 'LOST' THEN 'OTHER' ELSE NULL END,
           lost_notes = CASE WHEN $3 = 'LOST'
             THEN 'Perda recebida por etiqueta WA2.' ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 AND stage = $4 RETURNING *`,
        [...updateValues, event.waLabelId, event.waLabelName || null, action.id, receipt.id, event.observedAt],
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
      if (decision.exclusiveTransition) {
        await enqueueWa2LabelJobs(client, {
          lead: updated.rows[0],
          previousStage: lead.stage,
          stageHistoryId: history.rows[0].id,
        });
      }
      await ensureMetaEventForStage(client, {
        lead: updated.rows[0],
        stage: decision.targetStage,
        eventTime: new Date(event.observedAt),
        mode: process.env.META_TEST_MODE === 'true' ? 'test' : 'live',
        officialLabelEvidence: Boolean(
          currentRemoteLabelIds.includes(event.waLabelId) &&
          (currentCrmLabelStages.length <= 1 || decision.exclusiveTransition === true),
        ),
      });
      await completeManualStageRequestForReceipt(client, {
        leadId: lead.id,
        targetStage: decision.targetStage,
        actionId: action.id,
        receiptId: receipt.id,
      });
      void history;
    } else if (decision.action === 'NOOP' && decision.targetStage) {
      await client.query(
        `UPDATE leads SET
           stage_source = 'WHATSAPP_LABEL',
           source_label_id = $3,
           source_label_name = $4,
           source_action_id = $5,
           source_receipt_id = $6,
           source_observed_at = $7,
           stage_verified_at = now(),
           stage_verification_status = 'VERIFIED',
           updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), lead.id, event.waLabelId, event.waLabelName || null, action.id, receipt.id, event.observedAt],
      );
      await completeManualStageRequestForReceipt(client, {
        leadId: lead.id,
        targetStage: decision.targetStage,
        actionId: action.id,
        receiptId: receipt.id,
      });
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

export async function auditMqlEvents({
  auditRunId = crypto.randomUUID(),
  dryRun = true,
} = {}) {
  const result = await pool.query(
    `SELECT event.id, event.lead_id, event.event_time, event.status,
            event.validity_status, lead.stage, lead.is_internal_test,
            lead.meta_outbound_eligible,
            COALESCE(evidence.qualifying_label_count, 0)::int AS qualifying_label_count,
            COALESCE(evidence.active_qualifying_label_count, 0)::int AS active_qualifying_label_count,
            COALESCE(evidence.any_wa_evidence, false) AS any_wa_evidence,
            COALESCE(evidence.multiple_active_labels, false) AS multiple_active_labels,
            COALESCE(evidence.qualifying_label_removed, false) AS qualifying_label_removed,
            EXISTS (
              SELECT 1 FROM lead_stage_history history
              WHERE history.tenant_id = event.tenant_id AND history.lead_id = event.lead_id
                AND history.changed_at <= event.event_time
                AND history.activity_type = 'MANUAL_STAGE_APPROVED'
            ) AS manual_two_step,
            EXISTS (
              SELECT 1 FROM lead_stage_history history
              WHERE history.tenant_id = event.tenant_id AND history.lead_id = event.lead_id
                AND history.changed_at <= event.event_time
                AND (history.observation ILIKE '%reconciliação%'
                  OR history.observation ILIKE '%backfill%'
                  OR history.activity_type = 'HISTORICAL_IMPORT')
            ) AS reconciliation_evidence
     FROM meta_conversion_events event
     JOIN leads lead ON lead.tenant_id = event.tenant_id AND lead.id = event.lead_id
     LEFT JOIN LATERAL (
       SELECT
          (count(DISTINCT CASE WHEN receipt.operation = 'APPLY' THEN receipt.remote_label_id END)
            FILTER (WHERE binding.stage IN ('QUALIFIED','NEGOTIATING','OPPORTUNITY','AWAITING_ENROLLMENT','AWAITING_PAYMENT')))::int
           AS qualifying_label_count,
         count(DISTINCT CASE
           WHEN receipt.operation = 'APPLY'
            AND NOT EXISTS (
              SELECT 1 FROM wa2_label_event_receipts removed
              WHERE removed.tenant_id = receipt.tenant_id
                AND removed.remote_instance_id = receipt.remote_instance_id
                AND removed.remote_chat_id = receipt.remote_chat_id
                AND removed.remote_label_id = receipt.remote_label_id
                AND removed.operation = 'REMOVE'
                AND removed.observed_at > receipt.observed_at
                AND removed.observed_at <= event.event_time
            ) THEN receipt.remote_label_id END
          ) FILTER (WHERE binding.stage IN ('QUALIFIED','NEGOTIATING','OPPORTUNITY','AWAITING_ENROLLMENT','AWAITING_PAYMENT'))::int
           AS active_qualifying_label_count,
         count(receipt.id) > 0 AS any_wa_evidence,
         count(DISTINCT CASE WHEN receipt.operation = 'APPLY'
           AND NOT EXISTS (
             SELECT 1 FROM wa2_label_event_receipts removed
             WHERE removed.tenant_id = receipt.tenant_id
               AND removed.remote_instance_id = receipt.remote_instance_id
               AND removed.remote_chat_id = receipt.remote_chat_id
               AND removed.remote_label_id = receipt.remote_label_id
               AND removed.operation = 'REMOVE'
               AND removed.observed_at > receipt.observed_at
               AND removed.observed_at <= event.event_time
           ) THEN binding.stage END) > 1 AS multiple_active_labels,
         bool_or(binding.stage IN ('QUALIFIED','NEGOTIATING','OPPORTUNITY','AWAITING_ENROLLMENT','AWAITING_PAYMENT')
           AND receipt.operation = 'APPLY'
           AND EXISTS (
             SELECT 1 FROM wa2_label_event_receipts removed
             WHERE removed.tenant_id = receipt.tenant_id
               AND removed.remote_instance_id = receipt.remote_instance_id
               AND removed.remote_chat_id = receipt.remote_chat_id
               AND removed.remote_label_id = receipt.remote_label_id
               AND removed.operation = 'REMOVE'
               AND removed.observed_at > receipt.observed_at
               AND removed.observed_at <= event.event_time
           )) AS qualifying_label_removed
       FROM wa2_label_event_receipts receipt
       JOIN wa2_instances instance
         ON instance.tenant_id = receipt.tenant_id
        AND instance.remote_instance_id = receipt.remote_instance_id
       JOIN wa2_label_bindings binding
         ON binding.tenant_id = receipt.tenant_id
        AND binding.wa2_instance_id = instance.id
        AND binding.remote_label_id = receipt.remote_label_id
        AND binding.enabled = true
       JOIN wa2_contact_links link
         ON link.tenant_id = receipt.tenant_id
        AND link.lead_id = event.lead_id
        AND link.wa2_instance_id = instance.id
        AND link.remote_chat_id = receipt.remote_chat_id
        AND link.created_at <= event.event_time
        AND (link.unlinked_at IS NULL OR link.unlinked_at >= event.event_time)
       WHERE receipt.tenant_id = event.tenant_id
         AND receipt.observed_at <= event.event_time
     ) evidence ON true
     WHERE event.tenant_id = $1 AND event.event_name = 'Marketing Qualified Lead'
     ORDER BY event.event_time, event.created_at, event.id`,
    [tenantId()],
  );
  const audited = result.rows.map((row) => ({
    ...row,
    classification: classifyMqlEvidence({
      internalTest: row.is_internal_test === true,
      qualifyingLabelCount: Number(row.qualifying_label_count || 0),
      activeQualifyingLabelCount: Number(row.active_qualifying_label_count || 0),
      qualifyingLabelRemovedBeforeEvent: row.qualifying_label_removed === true,
      anyWaEvidence: row.any_wa_evidence === true,
      stageOnly: ['QUALIFIED', 'NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']
        .includes(row.stage) && row.any_wa_evidence !== true,
      reconciliationEvidence: row.reconciliation_evidence === true,
      multipleLabels: row.multiple_active_labels === true,
      manualTwoStep: row.manual_two_step === true,
    }),
  }));
  const counts = Object.fromEntries(MQL_AUDIT_CLASSES.map((classification) => [classification, 0]));
  for (const row of audited) counts[row.classification] = (counts[row.classification] || 0) + 1;
  if (!dryRun) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of audited) {
        if (row.classification === 'VALID_LABEL_CONFIRMED' || row.classification === 'VALID_MANUAL_TWO_STEP') continue;
        const updated = await client.query(
          `UPDATE meta_conversion_events
           SET validity_status = 'INVALIDATED', invalidated_at = COALESCE(invalidated_at, now()),
               invalidated_reason = $3, audit_run_id = $4, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND validity_status <> 'INVALIDATED'
           RETURNING id`,
          [tenantId(), row.id, row.classification, auditRunId],
        );
        if (updated.rowCount === 1) {
          await client.query(
            `INSERT INTO lead_stage_history (
               tenant_id, lead_id, previous_stage, new_stage, origin,
               observation, activity_type, metadata, meta_event_id
             ) VALUES ($1,$2,$3,$3,'SYSTEM',$4,'MQL_INVALIDATED',$5,$6)`,
            [
              tenantId(), row.lead_id, row.stage,
              'Evento MQL invalidado localmente após auditoria WA2; resposta Meta preservada.',
              { auditRunId, classification: row.classification }, row.id,
            ],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { auditRunId, dryRun, total: audited.length, counts, rows: audited };
}

async function loadStageTruthRows() {
  const result = await pool.query(
    `${currentWa2LabelsCte()}
     SELECT lead.id, lead.stage, lead.is_internal_test, lead.meta_lead_id,
            lead.stage_source, lead.stage_verification_status,
            COALESCE(link_counts.active_link_count, 0)::int AS active_link_count,
            COALESCE(official.official_label_count, 0)::int AS official_label_count,
            official.binding_stages, official.source_label_id,
            official.source_label_name, official.source_action_id,
            official.source_receipt_id, official.source_observed_at,
            EXISTS (
              SELECT 1 FROM meta_conversion_events event
              WHERE event.tenant_id = lead.tenant_id AND event.lead_id = lead.id
                AND event.event_name = 'Marketing Qualified Lead'
                AND event.validity_status = 'VALID'
            ) AS valid_mql,
            EXISTS (
              SELECT 1 FROM meta_conversion_events event
              WHERE event.tenant_id = lead.tenant_id AND event.lead_id = lead.id
                AND event.event_name = 'Marketing Qualified Lead'
                AND event.status = 'SENT'
                AND event.validity_status = 'INVALIDATED'
            ) AS invalid_mql
     FROM leads lead
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS active_link_count
       FROM wa2_contact_links link
       JOIN wa2_instances instance
         ON instance.tenant_id = link.tenant_id AND instance.id = link.wa2_instance_id
        AND instance.enabled = true
       WHERE link.tenant_id = lead.tenant_id AND link.lead_id = lead.id
         AND link.unlinked_at IS NULL
     ) link_counts ON true
          LEFT JOIN LATERAL (
       SELECT count(DISTINCT current.remote_label_id)::int AS official_label_count,
               CASE WHEN count(DISTINCT current.remote_label_id) = 1
                 THEN array_agg(DISTINCT binding.stage) END AS binding_stages,
              CASE WHEN count(DISTINCT current.remote_label_id) = 1
                THEN min(current.remote_label_id) END AS source_label_id,
              CASE WHEN count(DISTINCT current.remote_label_id) = 1
                THEN min(current.remote_label_name) END AS source_label_name,
              CASE WHEN count(DISTINCT current.remote_label_id) = 1
                THEN (array_agg(action.id ORDER BY current.received_at DESC NULLS LAST))[1] END AS source_action_id,
              CASE WHEN count(DISTINCT current.remote_label_id) = 1
                THEN max(current.received_at) END AS source_observed_at,
              CASE WHEN count(DISTINCT current.remote_label_id) = 1
                THEN (array_agg(current.receipt_id ORDER BY current.received_at DESC NULLS LAST))[1] END AS source_receipt_id
       FROM current_wa2_labels current
       LEFT JOIN wa2_label_bindings binding
         ON binding.tenant_id = current.tenant_id
        AND binding.wa2_instance_id = current.wa2_instance_id
        AND binding.remote_label_id = current.remote_label_id
        AND binding.enabled = true
       LEFT JOIN wa2_inbound_label_actions action
         ON action.tenant_id = current.tenant_id
        AND action.receipt_id = current.receipt_id
       WHERE current.tenant_id = lead.tenant_id
         AND current.lead_id = lead.id
         AND current.operation = 'APPLY'
          AND binding.id IS NOT NULL
      ) official ON true
     WHERE lead.tenant_id = $1
     ORDER BY lead.created_at, lead.id`,
    [tenantId()],
  );
  return result.rows.map((row) => ({
    ...row,
    target_stage: canonicalStageForBindingStages(row.binding_stages),
  }));
}

function classifyLeadStageTruth(row) {
  if (row.is_internal_test === true || ['ENROLLED', 'PAID'].includes(row.stage)) {
    return 'PROTECTED_TERMINAL_STAGE';
  }
  if (Number(row.active_link_count) === 0) return 'NO_WA_LINK';
  if (Number(row.active_link_count) !== 1) return 'PENDING_IDENTITY';
  if (Number(row.official_label_count) > 1) return 'MULTIPLE_STAGE_LABELS';
  if (Number(row.official_label_count) === 0) {
    return ['QUALIFIED', 'OPPORTUNITY', 'NEGOTIATING', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']
      .includes(row.stage) ? 'CRM_QUALIFIED_WITHOUT_LABEL' : 'NO_OFFICIAL_STAGE_LABEL';
  }
  if (!row.target_stage || ['ENROLLED', 'PAID'].includes(row.target_stage)) {
    return 'PROTECTED_TERMINAL_STAGE';
  }
  if (!row.source_action_id || !row.source_receipt_id) return 'PENDING_IDENTITY';
  if (row.stage === row.target_stage) return 'ALIGNED_WITH_WHATSAPP';
  return 'SAFE_ALIGN_TO_WHATSAPP';
}

export async function auditLeadStageTruth({ dryRun = true, batchSize = 25 } = {}) {
  const rows = await loadStageTruthRows();
  const safeBatchSize = Math.max(1, Math.min(25, Number(batchSize) || 25));
  const counts = {
    ALIGNED_WITH_WHATSAPP: 0,
    SAFE_ALIGN_TO_WHATSAPP: 0,
    NO_OFFICIAL_STAGE_LABEL: 0,
    MULTIPLE_STAGE_LABELS: 0,
    NO_WA_LINK: 0,
    PENDING_IDENTITY: 0,
    CRM_QUALIFIED_WITHOUT_LABEL: 0,
    MQL_SENT_WITHOUT_LABEL: 0,
    PROTECTED_TERMINAL_STAGE: 0,
    MANUAL_LEGACY_UNVERIFIED: 0,
  };
  const audited = rows.map((row) => {
    const classification = classifyLeadStageTruth(row);
    counts[classification] += 1;
    if (classification === 'MQL_SENT_WITHOUT_LABEL') counts.MQL_SENT_WITHOUT_LABEL += 1;
    if (classification === 'ALIGNED_WITH_WHATSAPP' && row.stage_source === STAGE_SOURCES.LEGACY_UNVERIFIED) {
      counts.MANUAL_LEGACY_UNVERIFIED += 1;
    }
    if (row.invalid_mql && ['NO_OFFICIAL_STAGE_LABEL', 'CRM_QUALIFIED_WITHOUT_LABEL'].includes(classification)) {
      counts.MQL_SENT_WITHOUT_LABEL += 1;
    }
    return { ...row, classification };
  });
  if (!dryRun) {
    for (let offset = 0; offset < audited.length; offset += safeBatchSize) {
      const batch = audited.slice(offset, offset + safeBatchSize);
      for (const row of batch) {
        if (row.classification === 'SAFE_ALIGN_TO_WHATSAPP' && row.is_internal_test !== true) {
          await alignLeadStageToWhatsApp(row);
        } else if (row.classification === 'CRM_QUALIFIED_WITHOUT_LABEL' && row.is_internal_test !== true) {
          await neutralizeLeadWithoutWaStage(row);
        } else if (row.classification === 'ALIGNED_WITH_WHATSAPP' && row.stage_source !== STAGE_SOURCES.WHATSAPP_LABEL) {
          await alignLeadStageToWhatsApp(row, { forceHistory: true });
        }
      }
    }
  }
  return { dryRun, total: audited.length, counts, rows: audited };
}

async function alignLeadStageToWhatsApp(row, { forceHistory = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), row.id],
    );
    if (!current.rows[0]) throw new Error('LEAD_NOT_FOUND');
    const lead = current.rows[0];
    if (lead.is_internal_test === true || !row.target_stage) {
      await client.query('ROLLBACK');
      return { changed: false, reason: 'PROTECTED' };
    }
    const updated = await client.query(
      `UPDATE leads SET stage = $3, stage_source = 'WHATSAPP_LABEL',
         source_label_id = $4, source_label_name = $5,
         source_action_id = $6, source_receipt_id = $7,
         source_observed_at = $8, stage_verified_at = now(),
         stage_verification_status = 'VERIFIED', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId(), row.id, row.target_stage, row.source_label_id, row.source_label_name,
        row.source_action_id, row.source_receipt_id, row.source_observed_at],
    );
    if (forceHistory || lead.stage !== row.target_stage) {
      await client.query(
        `INSERT INTO lead_stage_history (
           tenant_id, lead_id, previous_stage, new_stage, origin,
           observation, activity_type, metadata
         ) VALUES ($1,$2,$3,$4,'WHATSAPP',$5,'STAGE_SOURCE_ALIGNED',$6)`,
        [
          tenantId(), row.id, lead.stage, row.target_stage,
          'Etapa alinhada à etiqueta oficial atual do WhatsApp.',
          { labelId: row.source_label_id, receiptId: row.source_receipt_id, actionId: row.source_action_id },
        ],
      );
    }
    await client.query('COMMIT');
    return { changed: lead.stage !== row.target_stage, lead: updated.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function neutralizeLeadWithoutWaStage(row) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId(), row.id],
    );
    const lead = current.rows[0];
    if (!lead || lead.is_internal_test === true || ['ENROLLED', 'PAID'].includes(lead.stage)) {
      await client.query('ROLLBACK');
      return { changed: false, reason: 'PROTECTED' };
    }
    await client.query(
      `UPDATE leads SET stage = 'NEW', stage_source = 'LEGACY_UNVERIFIED',
         source_label_id = NULL, source_label_name = NULL,
         source_action_id = NULL, source_receipt_id = NULL,
         source_observed_at = NULL, stage_verified_at = NULL,
         stage_verification_status = 'UNVERIFIED_NO_LABEL', updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), row.id],
    );
    await client.query(
      `INSERT INTO lead_stage_history (
         tenant_id, lead_id, previous_stage, new_stage, origin,
         observation, activity_type, metadata
       ) VALUES ($1,$2,$3,'NEW','SYSTEM',$4,'STAGE_SOURCE_NEUTRALIZED',$5)`,
      [
        tenantId(), row.id, lead.stage,
        'Etapa neutralizada porque não há etiqueta oficial atual do WhatsApp.',
        { previousSource: lead.stage_source, verificationStatus: 'UNVERIFIED_NO_LABEL' },
      ],
    );
    await client.query('COMMIT');
    return { changed: lead.stage !== 'NEW' };
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
  if (process.env.META_CLEAN_HISTORICAL_BACKFILL !== 'true') return null;
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
  if (process.env.WA2_DAILY_RECONCILIATION_ENABLED !== 'true') {
    throw new Wa2DataError('Reconciliação WA2 desabilitada', 'WA2_RECONCILIATION_DISABLED');
  }
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

export async function withWa2DailyReconciliationLock(callback) {
  if (typeof callback !== 'function') throw new TypeError('Callback do lock diário é obrigatório');
  if (process.env.WA2_DAILY_RECONCILIATION_ENABLED !== 'true') {
    return { locked: false, disabled: true };
  }
  const client = await pool.connect();
  let localRunDate;
  let locked = false;
  const lockKey = () => `WA2_DAILY_RECONCILIATION:${tenantId()}:${localRunDate}`;
  try {
    const dateResult = await client.query(
      `SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS local_run_date`,
    );
    localRunDate = dateResult.rows[0]?.local_run_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localRunDate))) {
      throw new Error('Data local do agendamento WA2 inválida');
    }
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [lockKey()],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { locked: false, localRunDate };
    return {
      locked: true,
      localRunDate,
      value: await callback(localRunDate),
    };
  } finally {
    if (locked) {
      await client.query(
        `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
        [lockKey()],
      ).catch(() => undefined);
    }
    client.release();
  }
}

export async function claimDailyWa2ReconciliationDecision(localRunDate) {
  const result = await pool.query(
    `INSERT INTO scheduled_task_runs (tenant_id, task_name, local_run_date)
     VALUES ($1, 'WA2_DAILY_RECONCILIATION', $2::date)
     ON CONFLICT DO NOTHING
     RETURNING local_run_date`,
    [tenantId(), localRunDate],
  );
  return result.rows.length > 0;
}

export async function releaseDailyWa2ReconciliationDecision(localRunDate) {
  await pool.query(
    `DELETE FROM scheduled_task_runs
     WHERE tenant_id = $1
       AND task_name = 'WA2_DAILY_RECONCILIATION'
       AND local_run_date = $2::date`,
    [tenantId(), localRunDate],
  );
}

export async function enqueueDailyWa2Reconciliations(
  readyLocalInstanceIds,
  { decisionClaimed = false, localRunDate = null } = {},
) {
  if (process.env.WA2_DAILY_RECONCILIATION_ENABLED !== 'true') return 0;
  if (!Array.isArray(readyLocalInstanceIds) || readyLocalInstanceIds.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!decisionClaimed) {
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
  if (process.env.WA2_DAILY_RECONCILIATION_ENABLED !== 'true') return null;
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
  const [cursor, imports, fileImports, conflicts, confirmations] = await Promise.all([
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
    reconciliations: [],
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
