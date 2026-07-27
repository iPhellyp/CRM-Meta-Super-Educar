import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { canTransition, getStageEventName, isValidHistoryOrigin } from './funnel.js';

const { Pool } = pg;
const DEFAULT_TENANT_ID = 'super-educar';
const WORKER_NAME = 'meta-worker';

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

  if (input.metaLeadId) {
    const result = await pool.query(
      `INSERT INTO leads (
        tenant_id, name, email, phone, course, city, source, stage,
        meta_lead_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id,
        meta_campaign_id, meta_created_at, received_at, raw_meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (tenant_id, meta_lead_id) WHERE meta_lead_id IS NOT NULL
      DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
        email = COALESCE(NULLIF(EXCLUDED.email, ''), leads.email),
        phone = COALESCE(NULLIF(EXCLUDED.phone, ''), leads.phone),
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
    `INSERT INTO leads (tenant_id, name, email, phone, course, city, source, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      currentTenantId,
      input.name,
      input.email || null,
      input.phone || null,
      input.course || null,
      input.city || null,
      input.source || 'MANUAL',
      input.stage || 'NEW',
    ],
  );
  return result.rows[0];
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
    await client.query(
      `INSERT INTO lead_stage_history (
         lead_id, tenant_id, previous_stage, new_stage, origin, changed_by, observation
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, lead.tenant_id, previousLead.stage, stage, origin, changedBy, observation],
    );

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
