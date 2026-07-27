import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.join(here, '..', 'sql', '004_wa2_label_sync.sql'),
  'utf8',
);
const dbSource = fs.readFileSync(path.join(here, '..', 'src', 'db.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(here, '..', 'src', 'worker.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(here, '..', 'src', 'server.js'), 'utf8');

test('migration 004 é aditiva e não contém operação destrutiva', () => {
  assert.match(migration, /CREATE TABLE wa2_label_bindings/);
  assert.match(migration, /CREATE TABLE wa2_label_jobs/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
});

test('migration 004 usa FKs compostas por tenant e RESTRICT', () => {
  for (const parent of [
    'leads',
    'wa2_instances',
    'wa2_contact_links',
    'lead_stage_history',
  ]) {
    assert.match(
      migration,
      new RegExp(`REFERENCES ${parent} \\(tenant_id, id\\)[\\s\\S]*?ON DELETE RESTRICT`),
    );
  }
  assert.match(
    migration,
    /UNIQUE \(tenant_id, wa2_instance_id, stage\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(\s*tenant_id,\s*stage_history_id,\s*wa2_instance_id,\s*wa2_contact_link_id\s*\)/,
  );
});

test('migration restringe etapas, status, tentativas e IDs remotos', () => {
  for (const stage of [
    'NEW',
    'CONTACTED',
    'QUALIFIED',
    'VESTIBULAR_REGISTERED',
    'VESTIBULAR_COMPLETED',
    'MATRICULATED',
    'LOST',
  ]) {
    assert.match(migration, new RegExp(`'${stage}'`));
  }
  assert.doesNotMatch(migration, /'OPPORTUNITY'/);
  assert.match(migration, /status IN \('PENDING', 'RUNNING', 'DONE', 'FAILED'\)/);
  assert.match(migration, /attempts >= 0/);
  assert.match(migration, /max_attempts BETWEEN 1 AND 10/);
  assert.match(migration, /remote_label_id ~ '\^\[A-Za-z0-9_-\]\+\$'/);
});

test('migration possui índices para claim, stale, administração e lead', () => {
  for (const index of [
    'wa2_label_jobs_claim_idx',
    'wa2_label_jobs_stale_idx',
    'wa2_label_jobs_tenant_created_idx',
    'wa2_label_jobs_lead_created_idx',
  ]) {
    assert.match(migration, new RegExp(`CREATE INDEX ${index}`));
  }
  assert.match(migration, /WHERE status = 'RUNNING'/);
});

test('mudança de etapa grava histórico e job WA2 antes do mesmo COMMIT', () => {
  const moveStart = dbSource.indexOf('export async function moveLeadStage');
  const moveEnd = dbSource.indexOf('export async function enqueueLeadgenJobs');
  const source = dbSource.slice(moveStart, moveEnd);
  assert.ok(moveStart >= 0 && moveEnd > moveStart);
  assert.ok(source.indexOf('INSERT INTO lead_stage_history') >= 0);
  assert.ok(source.indexOf('enqueueWa2LabelJobs') > source.indexOf('INSERT INTO lead_stage_history'));
  assert.ok(source.indexOf("client.query('COMMIT')") > source.indexOf('enqueueWa2LabelJobs'));
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /listWa2Labels|applyWa2ChatLabel|removeWa2ChatLabel/);
});

test('ausência de vínculo ou binding não bloqueia etapa e deduplicação é local', () => {
  const start = dbSource.indexOf('async function enqueueWa2LabelJobs');
  const end = dbSource.indexOf('export async function moveLeadStage');
  const source = dbSource.slice(start, end);
  assert.match(source, /LEFT JOIN wa2_label_bindings target/);
  assert.match(source, /NO_ACTIVE_LINK/);
  assert.match(source, /NO_ENABLED_BINDING/);
  assert.match(source, /LABEL_UNCHANGED/);
  assert.match(source, /ON CONFLICT \([\s\S]*stage_history_id[\s\S]*\) DO NOTHING/);
});

test('claim é concorrente, recupera RUNNING stale e respeita max attempts', () => {
  const start = dbSource.indexOf('export async function claimNextWa2LabelJob');
  const end = dbSource.indexOf('export async function getWa2LabelJobContext');
  const source = dbSource.slice(start, end);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /status = 'RUNNING'/);
  assert.match(source, /locked_at < now\(\) - interval '5 minutes'/);
  assert.match(source, /attempts < max_attempts/);
  assert.match(source, /attempts = job\.attempts \+ 1/);
  assert.match(source, /WA2_MAX_ATTEMPTS/);
});

test('retry manual preserva attempts, limpa estado e isola tenant', () => {
  const start = dbSource.indexOf('export async function retryFailedWa2LabelJob');
  const end = dbSource.indexOf('export async function listWa2LabelJobs');
  const source = dbSource.slice(start, end);
  assert.match(source, /status = 'FAILED'/);
  assert.match(source, /tenant_id = \$2/);
  assert.match(source, /status = 'PENDING'/);
  assert.match(source, /locked_at = NULL/);
  assert.match(source, /finished_at = NULL/);
  assert.match(source, /last_error_code = NULL/);
  assert.match(source, /LEAST\(10, attempts \+ 1\)/);
  assert.doesNotMatch(source, /attempts\s*=\s*0/);
});

test('confirmação remota pendente volta à fila sem erro terminal', () => {
  const start = dbSource.indexOf(
    'export async function requeueWa2LabelJobForRemoteConfirmation',
  );
  const end = dbSource.indexOf('export async function failWa2LabelJob');
  const source = dbSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /status = 'PENDING'/);
  assert.match(source, /available_at = \$3/);
  assert.match(source, /locked_at = NULL/);
  assert.match(source, /finished_at = NULL/);
  assert.match(source, /last_error_code = \$4/);
  assert.match(source, /last_error_message = NULL/);
  assert.match(source, /tenant_id = \$2/);
  assert.doesNotMatch(source, /status = 'DONE'|status = 'FAILED'/);
});

test('worker mantém Meta, processa WA2 fora de transação e separa falhas', () => {
  assert.match(workerSource, /claimNextJob\(\)/);
  assert.match(workerSource, /claimNextWa2LabelJob\(\)/);
  assert.match(workerSource, /synchronizeWa2LabelJob/);
  assert.match(workerSource, /wa2LabelJobCompletionDecision/);
  assert.match(workerSource, /requeueWa2LabelJobForRemoteConfirmation/);
  assert.match(workerSource, /WA2_LABEL_SYNC_NOT_CONFIRMED|decision\.error/);
  assert.match(workerSource, /handleWa2LabelFailure/);
  assert.match(workerSource, /isTemporaryWa2LabelError/);
  assert.match(workerSource, /wa2LabelRetryDelayMs/);
  assert.doesNotMatch(workerSource, /\bBEGIN\b|\bCOMMIT\b|FOR UPDATE/);
});

test('rotas WA2 ficam após autenticação/CSRF e retry usa somente ID local', () => {
  const authIndex = serverSource.indexOf('app.use(requireAuth)');
  const csrfIndex = serverSource.indexOf("req.method === 'POST' ? requireCsrf");
  const labelsIndex = serverSource.indexOf("app.get('/wa2/labels'");
  const retryIndex = serverSource.indexOf("app.post('/wa2/label-jobs/:id/retry'");
  assert.ok(authIndex >= 0 && csrfIndex > authIndex);
  assert.ok(labelsIndex > csrfIndex && retryIndex > csrfIndex);
  const retryRoute = serverSource.slice(retryIndex, serverSource.indexOf(
    "app.get('/wa2/instances/:id'",
  ));
  assert.match(retryRoute, /z\.string\(\)\.uuid\(\)/);
  assert.doesNotMatch(retryRoute, /tenantId|remote_instance_id|remoteLabelId/);
});
