import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { canTransition, getStageEventName, isValidHistoryOrigin } from './funnel.js';
import { normalizeWhatsAppPhoneOrNull } from './phone.js';
import {
  Wa2LinkRuleError as Wa2DataError,
  assertNoActiveWa2LinkConflict,
  validateWa2LinkParents,
} from './wa2-link-rules.js';
import {
  isWa2LabelStage,
  stagesSharingWa2Label,
} from './wa2-label-sync.js';

const { Pool } = pg;
const DEFAULT_TENANT_ID = 'super-educar';
const WORKER_NAME = 'meta-worker';

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

export async function listLeads({ stage, search, limit = 200, createdAfter = operationStartAt() } = {}) {
  const values = [tenantId()];
  const where = ['tenant_id = $1'];

  if (stage) {
    values.push(stage);
    where.push(`stage = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    where.push(`(name ILIKE $${values.length} OR phone ILIKE $${values.length} OR email ILIKE $${values.length} OR course ILIKE $${values.length})`);
  }

  if (createdAfter) {
    values.push(createdAfter);
    where.push(`COALESCE(received_at, created_at) >= $${values.length}`);
  }

  values.push(limit);
  const result = await pool.query(
    `SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function getLeadById(id) {
  const result = await pool.query(
    'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2',
    [id, tenantId()],
  );
  return result.rows[0] || null;
}

export async function upsertLead(input) {
  const currentTenantId = input.tenantId || tenantId();
  const phoneNormalized = normalizeWhatsAppPhoneOrNull(input.phone);

  if (input.metaLeadId) {
    const result = await pool.query(
      `INSERT INTO leads (
        tenant_id, name, email, phone, phone_normalized, course, city, source, stage,
        meta_lead_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id,
        meta_campaign_id, meta_created_at, received_at, raw_meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (tenant_id, meta_lead_id) WHERE meta_lead_id IS NOT NULL
      DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
        email = COALESCE(NULLIF(EXCLUDED.email, ''), leads.email),
        phone = COALESCE(NULLIF(EXCLUDED.phone, ''), leads.phone),
        phone_normalized = CASE
          WHEN NULLIF(EXCLUDED.phone, '') IS NOT NULL THEN EXCLUDED.phone_normalized
          ELSE leads.phone_normalized
        END,
        course = COALESCE(NULLIF(EXCLUDED.course, ''), leads.course),
        city = COALESCE(NULLIF(EXCLUDED.city, ''), leads.city),
        meta_page_id = COALESCE(NULLIF(EXCLUDED.meta_page_id, ''), leads.meta_page_id),
        meta_form_id = COALESCE(EXCLUDED.meta_form_id, leads.meta_form_id),
        meta_ad_id = COALESCE(EXCLUDED.meta_ad_id, leads.meta_ad_id),
        meta_adset_id = COALESCE(EXCLUDED.meta_adset_id, leads.meta_adset_id),
        meta_campaign_id = COALESCE(EXCLUDED.meta_campaign_id, leads.meta_campaign_id),
        meta_created_at = COALESCE(EXCLUDED.meta_created_at, leads.meta_created_at),
        received_at = COALESCE(leads.received_at, EXCLUDED.received_at),
        raw_meta = COALESCE(EXCLUDED.raw_meta, leads.raw_meta),
        updated_at = now()
      RETURNING *`,
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
      ],
    );
    return result.rows[0];
  }

  const result = await pool.query(
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
  return result.rows[0];
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
       tenant_id, remote_instance_id, name, role, last_verified_at
     ) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (remote_instance_id) DO UPDATE SET
       name = EXCLUDED.name,
       role = EXCLUDED.role,
       last_verified_at = now(),
       updated_at = now()
     WHERE wa2_instances.tenant_id = EXCLUDED.tenant_id
     RETURNING *`,
    [
      tenantId(),
      remoteData.id,
      remoteData.name || null,
      remoteData.role || null,
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
            instance.remote_instance_id, instance.enabled AS instance_enabled
     FROM wa2_label_bindings binding
     JOIN wa2_instances instance
       ON instance.id = binding.wa2_instance_id
      AND instance.tenant_id = binding.tenant_id
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
  const eventId = `crm:${lead.id}:${eventName.replaceAll(' ', '_').toLowerCase()}:${mode}`;
  const inserted = await client.query(
    `INSERT INTO meta_conversion_events (
       tenant_id, lead_id, event_name, event_id, event_time
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [lead.tenant_id, lead.id, eventName, eventId, eventTime],
  );
  if (inserted.rowCount === 1) return inserted.rows[0];
  const existing = await client.query(
    'SELECT * FROM meta_conversion_events WHERE event_id = $1',
    [eventId],
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
  return result.rowCount === 1;
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
  mode = 'live',
} = {}) {
  if (!isValidHistoryOrigin(origin)) {
    throw new Error('Origem de histórico inválida');
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
      CONTACTED: 'first_contact_at',
      QUALIFIED: 'qualified_at',
      VESTIBULAR_COMPLETED: 'opportunity_at',
      MATRICULATED: 'converted_at',
      LOST: 'lost_at',
    }[stage];
    const setTimestamp = timestampColumn
      ? `, ${timestampColumn} = COALESCE(${timestampColumn}, now())${
        stage === 'MATRICULATED' ? ', matriculated_at = COALESCE(matriculated_at, now())' : ''
      }`
      : '';

    const updated = await client.query(
      `UPDATE leads SET stage = $2, updated_at = now() ${setTimestamp}
       WHERE id = $1 AND tenant_id = $3 RETURNING *`,
      [id, stage, tenantId()],
    );
    const lead = updated.rows[0];
    const historyResult = await client.query(
      `INSERT INTO lead_stage_history (
         lead_id, tenant_id, previous_stage, new_stage, origin, changed_by, observation
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [id, lead.tenant_id, previousLead.stage, stage, origin, changedBy, observation],
    );
    const wa2LabelSync = await enqueueWa2LabelJobs(client, {
      lead,
      previousStage: previousLead.stage,
      stageHistoryId: historyResult.rows[0].id,
    });

    let event = null;
    let jobCreated = false;
    if (eventName && lead.meta_lead_id) {
      event = await createOrGetMetaEvent(client, {
        lead,
        eventName,
        eventTime: timestampColumn ? lead[timestampColumn] : new Date(),
        mode,
      });
      jobCreated = await enqueueConversionJob(client, event);
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
      count(*) FILTER (WHERE stage = 'QUALIFIED')::int AS qualified,
      count(*) FILTER (WHERE stage = 'VESTIBULAR_REGISTERED')::int AS vestibular_registered,
      count(*) FILTER (
        WHERE stage IN ('VESTIBULAR_COMPLETED', 'OPPORTUNITY')
      )::int AS vestibular_completed,
      count(*) FILTER (WHERE stage = 'MATRICULATED')::int AS matriculated,
      count(*) FILTER (WHERE stage = 'LOST')::int AS lost,
      count(*) FILTER (WHERE meta_lead_id IS NOT NULL)::int AS attributed
    FROM leads
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `, values), getQueueHealth()]);
  const counts = result.rows[0];
  const qualifiedJourney = counts.qualified
    + counts.vestibular_registered
    + counts.vestibular_completed
    + counts.matriculated;
  return {
    ...counts,
    qualificationRate: counts.total ? Math.round((qualifiedJourney / counts.total) * 1000) / 10 : 0,
    matriculationRate: counts.total ? Math.round((counts.matriculated / counts.total) * 1000) / 10 : 0,
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
      WHERE (
        status IN ('PENDING', 'RETRY')
        AND next_attempt_at <= now()
      ) OR (
        status = 'PROCESSING'
        AND locked_at < now() - interval '5 minutes'
      )
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
  `);
  return result.rows[0] ?? null;
}

export async function completeJob(id) {
  await pool.query(
    `UPDATE meta_jobs
     SET status = 'COMPLETED', last_error = NULL, locked_at = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

export async function failJob(id, error, { retryAt = null } = {}) {
  const status = retryAt ? 'RETRY' : 'FAILED';
  const result = await pool.query(
    `UPDATE meta_jobs
     SET status = $2, last_error = $3, next_attempt_at = COALESCE($4, next_attempt_at),
         locked_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, String(error).slice(0, 2000), retryAt],
  );
  return result.rows[0];
}

export async function getMetaEventContext(id) {
  const result = await pool.query(
    `SELECT e.*, l.name, l.email, l.phone, l.meta_lead_id
     FROM meta_conversion_events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.id = $1 AND e.tenant_id = $2 AND l.tenant_id = $2`,
    [id, tenantId()],
  );
  return result.rows[0] ?? null;
}

export async function markMetaEventProcessing(id, attempts) {
  await pool.query(
    `UPDATE meta_conversion_events
     SET status = 'PROCESSING', attempts = $2, updated_at = now()
     WHERE id = $1 AND status <> 'SENT'`,
    [id, attempts],
  );
}

export async function markMetaEventSent(id, response, attempts) {
  await pool.query(
    `UPDATE meta_conversion_events
     SET status = 'SENT', attempts = $3, meta_response = $2,
         sent_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1 AND status <> 'SENT'`,
    [id, response, attempts],
  );
}

export async function markMetaEventFailed(id, error, attempts, willRetry) {
  await pool.query(
    `UPDATE meta_conversion_events
     SET status = $2, attempts = $3, last_error = $4, updated_at = now()
     WHERE id = $1 AND status <> 'SENT'`,
    [id, willRetry ? 'RETRY' : 'FAILED', attempts, String(error).slice(0, 2000)],
  );
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
         WHERE id = $1 AND status = 'FAILED'`,
        [job.payload.eventId],
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
  const result = await pool.query(
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
  return result.rows[0] || null;
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
