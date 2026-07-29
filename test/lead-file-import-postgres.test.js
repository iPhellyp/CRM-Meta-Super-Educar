import assert from 'node:assert/strict';
import test from 'node:test';

const url = process.env.TEST_DATABASE_URL;

test('importacao persiste JSONB real sem 22P02 e preserva stage', {
  skip: !url,
  timeout: 120_000,
}, async (t) => {
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = 'false';
  process.env.DEFAULT_TENANT_ID =
    process.env.DEFAULT_TENANT_ID || `jsonb-test-${process.pid}`;

  const {
    cancelLeadFileImport,
    confirmLeadFileImport,
    createLeadFileImportPreview,
    migrate,
    pool,
  } = await import(`../src/db.js?integration=${Date.now()}`);
  const { parseLeadFile } = await import('../src/lead-file-import.js');

  const tenant = process.env.DEFAULT_TENANT_ID;

  async function cleanup() {
    await pool.query('DELETE FROM lead_file_import_items WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM lead_file_imports WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM meta_conversion_events WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM lead_stage_history WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM leads WHERE tenant_id=$1', [tenant]);
  }

  await migrate();
  await cleanup();

  t.after(async () => {
    try { await cleanup(); } finally { await pool.end(); }
  });

  const suffix = `${Date.now()}-${process.pid}`;

  const invalid = parseLeadFile(Buffer.from([
    'id,created_time,Nome,WhatsApp',
    `invalid-${suffix}-a,2026-07-29T09:00:00-03:00,Lead A,00000000000`,
    `invalid-${suffix}-b,data-invalida,Lead B,111`,
  ].join('\n')), `invalid-${suffix}.csv`);

  const invalidPreview = await createLeadFileImportPreview(
    invalid,
    'postgres-integration',
  );

  const errors = await pool.query(
    `SELECT errors, jsonb_typeof(errors) AS type
       FROM lead_file_import_items
      WHERE tenant_id=$1 AND import_id=$2
      ORDER BY row_number`,
    [tenant, invalidPreview.id],
  );

  assert.equal(errors.rowCount, 2);
  for (const row of errors.rows) {
    assert.equal(row.type, 'array');
    assert.ok(Array.isArray(row.errors));
    assert.ok(row.errors.length > 0);
  }

  const previewRecord = await pool.query(
    `SELECT summary, jsonb_typeof(summary) AS type
       FROM lead_file_imports
      WHERE tenant_id=$1 AND id=$2`,
    [tenant, invalidPreview.id],
  );

  assert.equal(previewRecord.rows[0].type, 'object');
  assert.equal(previewRecord.rows[0].summary.invalid, 2);

  const before = await pool.query(
    'SELECT count(*)::int AS count FROM leads WHERE tenant_id=$1',
    [tenant],
  );
  assert.equal(before.rows[0].count, 0);

  assert.equal(await cancelLeadFileImport(invalidPreview.id), true);

  const metaLeadId = `valid-${suffix}`;
  const phone = '11999999999';

  const valid = parseLeadFile(Buffer.from([
    'id,created_time,Nome,WhatsApp,ad_name',
    `${metaLeadId},2026-07-29T09:00:00-03:00,Lead Valido,${phone},Anuncio Teste`,
  ].join('\n')), `valid-${suffix}.csv`);

  const validPreview = await createLeadFileImportPreview(
    valid,
    'postgres-integration',
  );

  const rawMeta = await pool.query(
    `SELECT raw_meta, jsonb_typeof(raw_meta) AS type
       FROM lead_file_import_items
      WHERE tenant_id=$1 AND import_id=$2`,
    [tenant, validPreview.id],
  );

  assert.equal(rawMeta.rows[0].type, 'object');
  assert.equal(rawMeta.rows[0].raw_meta.ad_name, 'Anuncio Teste');

  const first = await confirmLeadFileImport(
    validPreview.id,
    'postgres-integration',
  );
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.idempotent, false);
  assert.equal(first.applied_count, 1);

  const second = await confirmLeadFileImport(
    validPreview.id,
    'postgres-integration',
  );
  assert.equal(second.idempotent, true);

  await pool.query(
    `UPDATE leads SET stage='QUALIFIED'
      WHERE tenant_id=$1 AND meta_lead_id=$2`,
    [tenant, metaLeadId],
  );

  const update = parseLeadFile(Buffer.from([
    'id,created_time,Nome,WhatsApp',
    `${metaLeadId},2026-07-29T09:10:00-03:00,Lead Atualizado,${phone}`,
  ].join('\n')), `update-${suffix}.csv`);

  const updatePreview = await createLeadFileImportPreview(
    update,
    'postgres-integration',
  );
  assert.equal(updatePreview.items[0].decision, 'UPDATE');

  await confirmLeadFileImport(updatePreview.id, 'postgres-integration');

  const lead = await pool.query(
    `SELECT name, stage FROM leads
      WHERE tenant_id=$1 AND meta_lead_id=$2`,
    [tenant, metaLeadId],
  );

  assert.equal(lead.rowCount, 1);
  assert.equal(lead.rows[0].name, 'Lead Atualizado');
  assert.equal(lead.rows[0].stage, 'QUALIFIED');

  const duplicate = parseLeadFile(Buffer.from([
    'id,created_time,Nome,WhatsApp',
    `other-${suffix},2026-07-29T09:15:00-03:00,Duplicado,${phone}`,
  ].join('\n')), `duplicate-${suffix}.csv`);

  const duplicatePreview = await createLeadFileImportPreview(
    duplicate,
    'postgres-integration',
  );
  assert.equal(duplicatePreview.items[0].decision, 'POSSIBLE_DUPLICATE');

  const duplicateResult = await confirmLeadFileImport(
    duplicatePreview.id,
    'postgres-integration',
  );
  assert.equal(duplicateResult.applied_count, 0);

  const finalCount = await pool.query(
    'SELECT count(*)::int AS count FROM leads WHERE tenant_id=$1',
    [tenant],
  );
  assert.equal(finalCount.rows[0].count, 1);
});
