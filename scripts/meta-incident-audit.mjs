import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const outputDir = path.resolve(process.argv[2] || './audit/meta-incident-2026-08-03');
const tenantId = process.env.DEFAULT_TENANT_ID || 'super-educar';
const legacyDatasetId = process.env.META_DATASET_ID || 'UNKNOWN_NOT_IN_ENV';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function csvValue(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : '';
}

function expectedLabels(row) {
  if (row.event_name === 'Marketing Qualified Lead') return ['CRM 02 - Qualificado'];
  if (row.event_name === 'Sales Opportunity') {
    if (row.current_stage === 'NEGOTIATING') return ['CRM 03 - Inscrição no vestibular'];
    return ['CRM 04 - Vestibular concluído'];
  }
  return [];
}

function classify(row) {
  const reasons = [];
  if (!['Marketing Qualified Lead', 'Sales Opportunity'].includes(row.event_name)) {
    reasons.push('EVENT_NAME_NOT_ALLOWED');
  }
  if (!row.meta_lead_id) reasons.push('META_LEAD_ID_MISSING');
  if (row.event_name === 'Marketing Qualified Lead' && row.current_stage !== 'QUALIFIED') {
    reasons.push('MQL_STAGE_MISMATCH');
  }
  if (row.event_name === 'Sales Opportunity'
    && !['NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].includes(row.current_stage)) {
    reasons.push('SALES_OPPORTUNITY_STAGE_MISMATCH');
  }
  if (row.active_link_count !== 1) reasons.push('ACTIVE_LINK_COUNT_NOT_ONE');
  if (row.phone_lead_count !== 1) reasons.push('PHONE_LEAD_COUNT_NOT_ONE');
  if (row.remote_chat_count !== 1) reasons.push('REMOTE_CHAT_COUNT_NOT_ONE');
  if (!row.evidence_receipt_id) reasons.push('NO_LOCAL_APPLY_EVIDENCE');
  if (row.evidence_operation && row.evidence_operation !== 'APPLY') reasons.push('EVIDENCE_NOT_APPLY');
  const labels = row.current_remote_labels || [];
  const official = labels.filter((label) => /^CRM (02|03|04)\b/.test(label));
  if (official.length !== 1) reasons.push('OFFICIAL_LABEL_COUNT_NOT_ONE');
  if (expectedLabels(row).length && !expectedLabels(row).some((label) => labels.includes(label))) {
    reasons.push('CURRENT_LABEL_MISMATCH');
  }
  if (reasons.some((reason) => reason.endsWith('MISMATCH') || reason === 'EVENT_NAME_NOT_ALLOWED' || reason === 'META_LEAD_ID_MISSING')) {
    return { audit_status: 'INVALID', audit_reason: reasons.join(';') };
  }
  if (reasons.length) return { audit_status: 'AMBIGUOUS', audit_reason: reasons.join(';') };
  return { audit_status: 'VALID', audit_reason: 'STRICT_LOCAL_EVIDENCE_MATCH' };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const result = await pool.query({
    text: `
      WITH current_labels AS (
        SELECT lead_id,
               array_agg(label_name ORDER BY label_name) AS labels
        FROM (
          SELECT DISTINCT ON (link.lead_id, receipt.remote_instance_id, receipt.remote_chat_id, receipt.remote_label_id)
                 link.lead_id,
                 COALESCE(receipt.remote_label_name, binding.remote_label_name, receipt.remote_label_id) AS label_name,
                 receipt.operation,
                 receipt.observed_at, receipt.received_at, receipt.id
          FROM wa2_contact_links link
          JOIN wa2_label_event_receipts receipt
            ON receipt.tenant_id = link.tenant_id
           AND receipt.remote_instance_id = (SELECT remote_instance_id FROM wa2_instances i WHERE i.id = link.wa2_instance_id)
           AND receipt.remote_chat_id = link.remote_chat_id
          LEFT JOIN wa2_label_bindings binding
            ON binding.tenant_id = receipt.tenant_id
           AND binding.wa2_instance_id = link.wa2_instance_id
           AND binding.remote_label_id = receipt.remote_label_id
          WHERE link.tenant_id = $1 AND link.unlinked_at IS NULL
          ORDER BY link.lead_id, receipt.remote_instance_id, receipt.remote_chat_id,
                   receipt.remote_label_id, receipt.observed_at DESC, receipt.received_at DESC, receipt.id DESC
        ) current_state
        WHERE operation = 'APPLY'
        GROUP BY lead_id
      ),
      link_stats AS (
        SELECT lead_id, count(*)::int AS active_link_count,
               count(DISTINCT remote_chat_id)::int AS remote_chat_count
        FROM wa2_contact_links
        WHERE tenant_id = $1 AND unlinked_at IS NULL
        GROUP BY lead_id
      ),
      phone_stats AS (
        SELECT phone_normalized, count(*)::int AS phone_lead_count
        FROM leads
        WHERE tenant_id = $1 AND phone_normalized IS NOT NULL
        GROUP BY phone_normalized
      ),
      evidence AS (
        SELECT DISTINCT ON (e.id)
               e.id AS event_row_id, receipt.id AS evidence_receipt_id,
               receipt.operation AS evidence_operation, receipt.observed_at AS evidence_observed_at
        FROM meta_conversion_events e
        JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
        JOIN wa2_contact_links link ON link.tenant_id = l.tenant_id AND link.lead_id = l.id AND link.unlinked_at IS NULL
        JOIN wa2_label_event_receipts receipt
          ON receipt.tenant_id = link.tenant_id
         AND receipt.remote_chat_id = link.remote_chat_id
         AND receipt.remote_instance_id = (SELECT remote_instance_id FROM wa2_instances i WHERE i.id = link.wa2_instance_id)
         AND receipt.operation = 'APPLY'
        WHERE e.tenant_id = $1
          AND COALESCE(receipt.remote_label_name, receipt.remote_label_id) IN (
            'CRM 02 - Qualificado', 'CRM 03 - Inscrição no vestibular', 'CRM 04 - Vestibular concluído', '36', '63', '68'
          )
        ORDER BY e.id, receipt.observed_at DESC, receipt.received_at DESC, receipt.id DESC
      )
      SELECT e.id AS internal_event_id, e.lead_id AS internal_lead_id,
             l.name, l.phone, l.meta_lead_id, e.event_name, e.event_id,
             COALESCE(md.dataset_id, $2) AS dataset_id,
             e.event_time, e.sent_at, e.meta_response->>'fbtrace_id' AS fbtrace_id,
             l.stage AS current_stage,
             COALESCE(cl.labels, ARRAY[]::text[]) AS current_remote_labels,
             ev.evidence_receipt_id, ev.evidence_operation, ev.evidence_observed_at,
             COALESCE(ls.active_link_count, 0)::int AS active_link_count,
             COALESCE(ps.phone_lead_count, 0)::int AS phone_lead_count,
             COALESCE(ls.remote_chat_count, 0)::int AS remote_chat_count
      FROM meta_conversion_events e
      JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
      LEFT JOIN meta_datasets md ON md.tenant_id = e.tenant_id AND md.id = e.meta_dataset_id
      LEFT JOIN current_labels cl ON cl.lead_id = l.id
      LEFT JOIN link_stats ls ON ls.lead_id = l.id
      LEFT JOIN phone_stats ps ON ps.phone_normalized = l.phone_normalized
      LEFT JOIN evidence ev ON ev.event_row_id = e.id
      WHERE e.tenant_id = $1
      ORDER BY e.created_at, e.id
    `,
    values: [tenantId, legacyDatasetId],
  });
  const rows = result.rows.map((row) => ({
    ...row,
    phone_masked: maskPhone(row.phone),
    current_remote_labels: row.current_remote_labels || [],
    ...classify(row),
  }));
  const columns = [
    'internal_lead_id', 'name', 'phone_masked', 'meta_lead_id', 'event_name', 'event_id', 'dataset_id',
    'event_time', 'sent_at', 'fbtrace_id', 'current_stage', 'current_remote_labels',
    'evidence_receipt_id', 'evidence_operation', 'evidence_observed_at', 'active_link_count',
    'phone_lead_count', 'remote_chat_count', 'audit_status', 'audit_reason',
  ];
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvValue(
    column === 'current_remote_labels' ? row[column].join(' | ') : row[column],
  )).join(','))].join('\n');
  const writeCsv = (name, filtered) => fs.writeFile(path.join(outputDir, name), [columns.join(','), ...filtered.map((row) => columns.map((column) => csvValue(
    column === 'current_remote_labels' ? row[column].join(' | ') : row[column],
  )).join(','))].join('\n') + '\n');
  await Promise.all([
    fs.writeFile(path.join(outputDir, 'meta-incident-full-audit.csv'), `${csv}\n`),
    writeCsv('meta-incident-valid-events.csv', rows.filter((row) => row.audit_status === 'VALID')),
    writeCsv('meta-incident-invalid-events.csv', rows.filter((row) => row.audit_status === 'INVALID')),
    writeCsv('meta-incident-ambiguous-events.csv', rows.filter((row) => row.audit_status === 'AMBIGUOUS')),
    fs.writeFile(path.join(outputDir, 'meta-incident-summary.json'), JSON.stringify({
      generated_at: new Date().toISOString(), tenant_id: tenantId, legacy_dataset_id: legacyDatasetId,
      total_events: rows.length,
      by_status: Object.fromEntries(['VALID', 'INVALID', 'AMBIGUOUS'].map((status) => [
        status, rows.filter((row) => row.audit_status === status).length,
      ])),
      by_event_name: Object.fromEntries([...new Set(rows.map((row) => row.event_name))].map((name) => [
        name, rows.filter((row) => row.event_name === name).length,
      ])),
      note: 'Auditoria local; estado remoto WA2 não foi consultado nesta execução. VALID significa evidência local estrita, não confirmação remota.',
    }, null, 2) + '\n'),
  ]);
  console.log(JSON.stringify({ outputDir, total: rows.length, byStatus: {
    VALID: rows.filter((row) => row.audit_status === 'VALID').length,
    INVALID: rows.filter((row) => row.audit_status === 'INVALID').length,
    AMBIGUOUS: rows.filter((row) => row.audit_status === 'AMBIGUOUS').length,
  }}));
}

try {
  await main();
} finally {
  await pool.end();
}
