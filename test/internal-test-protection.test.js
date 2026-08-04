import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { canCreateMetaForStage, isInternalTestLead } from '../src/historical-sync.js';

const read = (file) => fs.readFile(file, 'utf8');

test('lead normal pode ser elegível e INTERNAL_TEST nunca é', () => {
  assert.equal(canCreateMetaForStage('QUALIFIED', true), true);
  assert.equal(isInternalTestLead({ is_internal_test: false, meta_outbound_eligible: true }), false);
  assert.equal(isInternalTestLead({ is_internal_test: true, meta_outbound_eligible: true }), true);
  assert.equal(isInternalTestLead({ is_internal_test: false, meta_outbound_eligible: false }), true);
});

test('migration cria flags persistentes e auditoria sem operação destrutiva', async () => {
  const sql = await read('sql/011_internal_test_leads.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS is_internal_test BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS meta_outbound_eligible BOOLEAN NOT NULL DEFAULT true/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS lead_internal_test_flags/);
  assert.match(sql, /flag TEXT NOT NULL DEFAULT 'INTERNAL_TEST'/);
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
});

test('migration permite auditar bloqueio INTERNAL_TEST no histórico', async () => {
  const sql = await read('sql/012_internal_test_history_activity.sql');
  assert.match(sql, /lead_stage_history_activity_type_check/);
  assert.match(sql, /META_EVENT_BLOCKED_INTERNAL_TEST/);
  assert.doesNotMatch(sql, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
});

test('bloqueio cobre criação, worker, retry, backfill e caminhos WA2', async () => {
  const db = await read('src/db.js');
  const worker = await read('src/worker.js');
  assert.match(db, /META_EVENT_BLOCKED_INTERNAL_TEST/);
  assert.match(db, /isInternalTestLead\(lead\)/);
  assert.match(db, /blocked_lead\.is_internal_test = true/);
  assert.match(db, /lead\.is_internal_test = false/);
  assert.match(db, /meta_outbound_eligible = true/);
  assert.match(db, /Retry bloqueado: lead marcado como INTERNAL_TEST/);
  assert.match(worker, /blockMetaConversionJob\(job\.id, event\.id\)/);
  assert.match(worker, /event\.is_internal_test === true/);
});

test('marcação exige lead_id interno, Meta Lead ID e confirmação explícita', async () => {
  const db = await read('src/db.js');
  const server = await read('src/server.js');
  assert.match(db, /INTERNAL_TEST_CONFIRMATION_REQUIRED/);
  assert.match(db, /META_LEAD_ID_MISMATCH/);
  assert.match(db, /MARK_INTERNAL_TEST/);
  assert.match(db, /META_EVENT_BLOCKED_INTERNAL_TEST/);
  assert.match(server, /app\.post\('\/leads\/:id\/internal-test'/);
  assert.match(server, /markLeadInternalTest\(/);
  assert.match(server, /requireCsrf/);
});

test('lead de teste permanece visível, mas sai de métricas e CSV', async () => {
  const db = await read('src/db.js');
  const server = await read('src/server.js');
  const views = await read('src/views.js');
  assert.match(db, /is_internal_test = false/);
  assert.match(server, /excludeInternalTests: true/);
  assert.match(views, /TESTE INTERNO — EVENTOS META BLOQUEADOS/);
  assert.match(views, /Eventos Meta bloqueados/);
  assert.match(views, /META_EVENT_BLOCKED_INTERNAL_TEST/);
});
