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

test('migration 006 converte matrícula manual legada sem confirmar matrícula real', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  const manualConversions = migration.match(
    /WHEN 'MATRICULATED' THEN 'AWAITING_ENROLLMENT'/g,
  ) || [];
  assert.equal(manualConversions.length, 5);
  assert.doesNotMatch(migration, /WHEN 'MATRICULATED' THEN 'ENROLLED'/);
  assert.match(
    migration,
    /UPDATE wa2_stage_confirmations[\s\S]*SET requested_stage = 'ENROLLED'[\s\S]*WHERE requested_stage = 'MATRICULATED'/,
  );
});

test('migration 006 usa FK composta tenant-safe para evento do histórico', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  assert.match(
    migration,
    /UNIQUE \(tenant_id, id\)[\s\S]*FOREIGN KEY \(tenant_id, meta_event_id\)[\s\S]*REFERENCES meta_conversion_events \(tenant_id, id\)[\s\S]*ON DELETE RESTRICT/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(meta_event_id\) REFERENCES meta_conversion_events\(id\)/,
  );
});

test('migration 006 aborta resultados legados desconhecidos antes da nova constraint', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  const guardAt = migration.indexOf('DO $$', migration.indexOf('UPDATE wa2_reconciliation_items SET result'));
  const constraintAt = migration.indexOf(
    'ADD CONSTRAINT wa2_reconciliation_items_result_check',
    guardAt,
  );
  assert.ok(guardAt > 0);
  assert.ok(constraintAt > guardAt);
  const guard = migration.slice(guardAt, constraintAt);
  assert.match(guard, /SELECT DISTINCT result/);
  assert.match(guard, /string_agg\(quote_literal\(result\), ', ' ORDER BY result\)/);
  assert.match(
    guard,
    /RAISE EXCEPTION[\s\S]*resultados antigos de reconciliação não reconhecidos/,
  );
  assert.doesNotMatch(guard, /ELSE 'ERROR'/);
});

test('migration 006 preserva RUNNING antes de PENDING ao deduplicar jobs ativos', async () => {
  const migration = await read('sql/006_commercial_wa2_meta_connections.sql');
  const dedupe = migration.slice(
    migration.indexOf('WITH duplicate_active_runs AS'),
    migration.indexOf('CREATE UNIQUE INDEX wa2_reconciliation_runs_active_uidx'),
  );
  assert.match(
    dedupe,
    /CASE status[\s\S]*WHEN 'RUNNING' THEN 0[\s\S]*WHEN 'PENDING' THEN 1[\s\S]*END,[\s\S]*created_at DESC,[\s\S]*id/,
  );
  assert.match(dedupe, /duplicate\.position > 1/);
});

test('migration 006 remove somente constraints compatíveis com o histórico real', async () => {
  const [migration004, migration005, migration006] = await Promise.all([
    read('sql/004_wa2_label_sync.sql'),
    read('sql/005_historical_meta_wa2_inbound.sql'),
    read('sql/006_commercial_wa2_meta_connections.sql'),
  ]);
  assert.match(migration004, /CONSTRAINT wa2_label_bindings_stage_check/);
  assert.match(migration004, /CONSTRAINT wa2_label_jobs_target_stage_check/);
  assert.match(
    migration005,
    /requested_stage TEXT NOT NULL CHECK \(requested_stage = 'MATRICULATED'\)/,
  );
  assert.match(
    migration005,
    /CREATE TABLE wa2_reconciliation_runs[\s\S]*status TEXT NOT NULL DEFAULT 'PENDING'[\s\S]*CHECK \(status IN/,
  );
  assert.match(
    migration005,
    /CREATE TABLE wa2_reconciliation_items[\s\S]*result TEXT CHECK \(/,
  );
  for (const name of [
    'wa2_label_bindings_stage_check',
    'wa2_label_jobs_target_stage_check',
    'wa2_stage_confirmations_requested_stage_check',
    'wa2_reconciliation_runs_status_check',
    'wa2_reconciliation_items_result_check',
  ]) {
    assert.match(migration006, new RegExp(`DROP CONSTRAINT ${name}`));
  }
  assert.doesNotMatch(migration006, /DROP CONSTRAINT IF EXISTS/);
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
  const app = await read('public/app.js');
  assert.match(views, /href="\$\{esc\(whatsappUrl\)\}"/);
  assert.match(views, /target="_blank" rel="noopener noreferrer" data-whatsapp-link/);
  assert.match(views, /data-whatsapp-log-url="\/leads\/\$\{esc\(lead\.id\)\}\/whatsapp-opened"/);
  assert.match(views, /data-whatsapp-csrf="\$\{esc\(csrfToken\)\}"/);
  assert.doesNotMatch(views, /data-whatsapp-form/);
  assert.match(views, /aria-live="polite"/);
  assert.match(views, /Abrir no WhatsApp/);
  assert.match(views, /Atualizar etapa/);
  assert.match(views, /Mais ações/);
  assert.match(views, /Encerrar lead/);
  assert.match(server, /app\.post\('\/leads\/:id\/whatsapp'/);
  assert.match(server, /app\.post\('\/leads\/:id\/whatsapp-opened'/);
  assert.ok(
    server.indexOf("app.use((req, res, next) => req.method === 'POST' ? requireCsrf")
      < server.indexOf("app.post('/leads/:id/whatsapp-opened'"),
  );
  assert.match(server, /createWhatsAppActionHandler/);
  assert.match(app, /navigator\.sendBeacon/);
  assert.match(app, /keepalive: true/);
  assert.doesNotMatch(app, /window\.open|about:blank/);
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
      name: '<img src=x onerror=alert(1)>',
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
  assert.match(html, /href="https:\/\/wa\.me\/5538991142298\?text=/);
  assert.match(html, /target="_blank" rel="noopener noreferrer" data-whatsapp-link/);
  assert.match(html, /data-whatsapp-log-url="\/leads\/11111111-1111-4111-8111-111111111111\/whatsapp-opened"/);
  assert.match(html, /data-whatsapp-csrf="csrf-test"/);
  assert.doesNotMatch(html, /data-whatsapp-form/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, />Abrir no WhatsApp</);
  assert.match(html, />Atualizar etapa</);
  assert.match(html, />Mais ações</);
  assert.doesNotMatch(html, /[◉⚙✕]/);
  assert.equal((html.match(/data-lost-lead=/g) || []).length, 2);
  assert.equal((html.match(/class="lead-card"/g) || []).length, 1);
  assert.match(html, /aria-labelledby="lost-dialog-title"/);
  assert.match(html, /aria-describedby="lost-dialog-description"/);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /stroke="currentColor"/);
  assert.match(html, /aria-hidden="true" focusable="false"/);
  const actionCell = html.slice(
    html.indexOf('<td data-label="Ações"'),
    html.indexOf('</td>', html.indexOf('<td data-label="Ações"')),
  );
  assert.doesNotMatch(actionCell, />\s*(Perder|Sem interesse|Telefone inválido|Duplicado)\s*</);
  assert.match(html, /Entrada desde/);
  assert.match(html, /Etiqueta WA2 \(ID ou nome\)/);
  assert.match(html, /Página 2/);
  assert.match(html, /Próxima →/);
});
