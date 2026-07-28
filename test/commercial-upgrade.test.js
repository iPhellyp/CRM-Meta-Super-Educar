import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from '../src/secret-crypto.js';
import { dashboardView } from '../src/views.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('migration 006 é versionada, tenant-safe e cria estruturas multi-Meta', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  const phoneMigration = await read('sql/003_wa2_contact_links.sql');
  for (const table of [
    'meta_connections',
    'meta_pages',
    'meta_forms',
    'meta_datasets',
    'tenant_settings',
    'scheduled_task_runs',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /FOREIGN KEY \(tenant_id, meta_connection_id\)/);
  assert.match(migration, /leads_meta_connection_idx/);
  assert.match(migration, /leads_commercial_stage_idx/);
  assert.match(phoneMigration, /leads_tenant_phone_normalized_idx/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM leads/i);
});

test('reconciliação impede jobs ativos duplicados e retry estrutural', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  const database = await read('src/db.js');
  assert.match(
    migration,
    /CREATE UNIQUE INDEX wa2_reconciliation_runs_active_uidx[\s\S]*WHERE status IN \('PENDING', 'RUNNING'\)/,
  );
  assert.match(
    database,
    /ON CONFLICT \(tenant_id, wa2_instance_id\)[\s\S]*WHERE status IN \('PENDING', 'RUNNING'\)[\s\S]*DO NOTHING/,
  );
  assert.match(
    database,
    /status = 'FAILED' AND attempts < 5[\s\S]*result NOT IN \('PHONE_EMPTY', 'PHONE_INVALID', 'LID_UNRESOLVED'\)/,
  );
  assert.match(database, /status = 'RUNNING' AND item\.locked_at < now\(\) - interval '5 minutes'/);
  assert.match(database, /heartbeat_at = now\(\)/);
});

test('CRM e WA2 preservam idempotência, loop guard e conflito', async () => {
  const database = await read('src/db.js');
  const historical = await read('src/historical-sync.js');
  const labelSync = await read('src/wa2-label-sync.js');
  assert.match(database, /ON CONFLICT \(\s*tenant_id, stage_history_id, wa2_instance_id, wa2_contact_link_id\s*\) DO NOTHING/);
  assert.match(historical, /INTERNAL_API_LOOP_GUARD/);
  assert.match(historical, /MULTIPLE_CRM_STAGE_LABELS/);
  assert.match(historical, /PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION/);
  assert.match(labelSync, /crm-label:\$\{digest\}/);
});

test('evento Meta usa conexão e dataset da origem, sem cruzar BM', async () => {
  const database = await read('src/db.js');
  const meta = await read('src/meta.js');
  assert.match(database, /dataset\.meta_connection_id = connection\.id/);
  assert.match(database, /connection\.id = \$2/);
  assert.match(database, /l\.meta_connection_id AS lead_meta_connection_id/);
  assert.match(meta, /event\.lead_meta_connection_id[\s\S]*!event\.meta_connection_id[\s\S]*!event\.meta_dataset_id/);
  assert.match(meta, /event\.dataset_id \|\| process\.env\.META_DATASET_ID/);
  assert.match(meta, /decryptSecret\(event\.encrypted_access_token\)/);
  assert.match(database, /WHERE e\.id = \$1 AND e\.tenant_id = \$2 AND l\.tenant_id = \$2/);
});

test('credenciais são cifradas com AES-GCM e mascaradas', () => {
  const env = {
    META_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
  const encrypted = encryptSecret('token-super-secreto', env);
  assert.notEqual(encrypted, 'token-super-secreto');
  assert.equal(decryptSecret(encrypted, env), 'token-super-secreto');
  assert.equal(maskSecret(encrypted), '••••••••');
});

test('interface abre WhatsApp sem confundir com Atendimento e registra histórico', async () => {
  const views = await read('src/views.js');
  const server = await read('src/server.js');
  assert.match(views, /<form method="post" action="\/leads\/\$\{esc\(lead\.id\)\}\/whatsapp" target="_blank" rel="noopener noreferrer">/);
  assert.match(views, />◉ Abrir WhatsApp<\/button>/);
  assert.match(views, /CONTACT_STARTED: 'stage-contact'/);
  assert.match(views, /target="_blank" rel="noopener noreferrer"/);
  assert.match(server, /app\.post\('\/leads\/:id\/whatsapp'/);
  assert.match(server, /await recordWhatsAppOpened\(lead\.id, req\.user\.sub\)/);
  assert.match(server, /template\.replaceAll\('\{\{nome\}\}'/);
  assert.doesNotMatch(views, /encrypted_access_token|encrypted_app_secret/);
});

test('agenda diária WA2 é persistente e inicia após 00h01', async () => {
  const database = await read('src/db.js');
  const worker = await read('src/worker.js');
  assert.match(database, /time '00:01'/);
  assert.match(database, /scheduled_task_runs/);
  assert.match(worker, /enqueueDailyWa2Reconciliations/);
});

test('dashboard renderiza WhatsApp protegido por CSRF, filtros e paginação', () => {
  const html = dashboardView({
    leads: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Lead',
      phone: '(38) 99114-2298',
      phone_normalized: '5538991142298',
      stage: 'NEW',
      received_at: '2026-07-28T12:00:00.000Z',
    }],
    counts: {
      total: 1, new: 1, in_service: 0, qualified: 0, opportunities: 0,
      enrolled: 0, paid: 0, lost: 0, qualificationRate: 0,
      matriculationRate: 0, metaPending: 0, metaRetry: 0, metaFailed: 0,
    },
    metaStatus: { configured: true, graphVersion: 'v25.0', testMode: false, missing: [] },
    filters: { sort: 'recent', page: 2 },
    pagination: { page: 2, hasNext: true },
    whatsappMessage: 'Olá, {{nome}}!',
    csrfToken: 'csrf-test',
  });
  assert.match(html, /action="\/leads\/11111111-1111-4111-8111-111111111111\/whatsapp"/);
  assert.match(html, /name="_csrf" value="csrf-test"/);
  assert.match(html, /Entrada desde/);
  assert.match(html, /Etiqueta WA2 \(ID\)/);
  assert.match(html, /Página 2/);
  assert.match(html, /Próxima →/);
});
