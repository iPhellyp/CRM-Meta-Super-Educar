import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

const read = (file) => fs.readFile(file, 'utf8');

test('Meta outbound fica desabilitado por padrão e não captura conversões', async () => {
  const stack = await read('docker-stack.yml');
  const db = await read('src/db.js');
  assert.match(stack, /META_CAPI_OUTBOUND_ENABLED: \$\{META_CAPI_OUTBOUND_ENABLED:-false\}/);
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
