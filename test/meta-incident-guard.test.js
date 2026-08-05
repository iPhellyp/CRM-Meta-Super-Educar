import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

const read = (file) => fs.readFile(file, 'utf8');

test('Meta outbound fica desabilitado por padrão e não captura conversões', async () => {
  const stack = await read('docker-stack.yml');
  const db = await read('src/db.js');
  assert.match(stack, /META_CAPI_OUTBOUND_ENABLED: \$\{META_CAPI_OUTBOUND_ENABLED:-false\}/);
  assert.match(stack, /source: meta_clean_env[\s\S]*target: meta-clean\.env/);
  assert.match(stack, /META_CLEAN_OUTBOUND_ENABLED: \$\{META_CLEAN_OUTBOUND_ENABLED:-false\}/);
  assert.match(db, /META_CAPI_OUTBOUND_ENABLED !== 'true'/);
  assert.match(db, /job_type <> 'CONVERSION'[\s\S]*\$2 = 'true'/);
});

test('dataset integra a chave determinística do evento', async () => {
  const db = await read('src/db.js');
  assert.match(db, /datasetKey/);
  assert.match(db, /crm:\$\{lead\.id\}:\$\{eventName\.replaceAll\(' ', '_'\)\.toLowerCase\(\)\}:\$\{datasetKey\}:\$\{mode\}/);
});

test('incidente antigo é marcado sem backfill e sem saída', async () => {
  const sql = await read('sql/010_meta_incident_controls.sql');
  assert.match(sql, /775516968145969/);
  assert.match(sql, /cutoff_at, allow_historical_backfill[\s\S]*VALUES/);
  assert.match(sql, /outbound_enabled = false/);
});

test('realtime rejeita dataset legado e não usa fallback para o token antigo', async () => {
  const meta = await read('src/meta.js');
  assert.match(meta, /META_LEGACY_DATASET_ID/);
  assert.match(meta, /eventDatasetId !== META_CLEAN_DATASET_ID/);
  assert.match(meta, /readMetaCleanConfig/);
  assert.match(await read('src/meta-clean-config.js'), /META_CLEAN_ACCESS_TOKEN/);
  const canary = meta.slice(
    meta.indexOf('export async function sendMetaCleanCanary'),
    meta.indexOf('export async function validateMetaAccessToken'),
  );
  assert.doesNotMatch(canary, /META_TEST_EVENT_CODE/);
});
