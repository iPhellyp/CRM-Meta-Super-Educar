import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
const migration = read('sql/005_historical_meta_wa2_inbound.sql');
const db = read('src/db.js');
const worker = read('src/worker.js');
const meta = read('src/meta.js');
const server = read('src/server.js');
const views = read('src/views.js');

test('migration 005 é aditiva, isolada por tenant e sem cascatas destrutivas', () => {
  assert.doesNotMatch(migration, /^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
  for (const table of [
    'wa2_label_event_cursors',
    'wa2_label_event_receipts',
    'wa2_inbound_label_actions',
    'wa2_label_conflicts',
    'wa2_stage_confirmations',
    'meta_historical_imports',
    'meta_historical_import_items',
    'wa2_reconciliation_runs',
    'wa2_reconciliation_items',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /UNIQUE \(event_id\)/);
  assert.match(migration, /UNIQUE \(tenant_id, event_id\)/);
  assert.match(migration, /ON DELETE RESTRICT/g);
});

test('claims são retomáveis, concorrentes e limitam o processamento', () => {
  assert.match(db, /claimWa2LabelEventCursor[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(db, /claimMetaHistoricalImport[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(db, /claimWa2ReconciliationItem[\s\S]*FOR UPDATE OF item SKIP LOCKED/);
  assert.match(worker, /limit: 100/);
  assert.match(worker, /for \(const event of page\.events\)/);
  assert.match(worker, /for \(const \[index, payload\] of page\.leads\.entries\(\)\)/);
  assert.match(worker, /metaHistoricalImportIsActive\(run\.id\)/);
  assert.doesNotMatch(worker, /Promise\.all\(page\.(events|leads)/);
});

test('eventId, cursor e ações são persistidos antes de avançar o feed', () => {
  assert.match(db, /ON CONFLICT \(tenant_id, event_id\) DO NOTHING/);
  assert.ok(db.indexOf('processWa2LabelEvent(event') < db.indexOf('completeWa2LabelEventPage'));
  assert.match(db, /origin, observation[\s\S]*'WHATSAPP'/);
  assert.match(db, /INTERNAL_API_LOOP_GUARD|decideInboundLabelAction/);
});

test('transição exclusiva agenda sincronização durável sem segunda ação ou histórico', () => {
  const inboundStart = db.indexOf('export async function processWa2LabelEvent');
  const inboundEnd = db.indexOf('export async function completeWa2LabelEventPage');
  const inbound = db.slice(inboundStart, inboundEnd);
  assert.match(inbound, /decision\.exclusiveTransition/);
  assert.match(inbound, /enqueueWa2LabelJobs\(client/);
  assert.match(inbound, /previousLabelObservedAt/);
  assert.match(inbound, /officialLabelEvidence:[\s\S]*decision\.exclusiveTransition/);
  assert.match(read('src/wa2-label-sync.js'), /pendingRemove/);
});

test('etapas protegidas geram conflito sem Converted automático no consumidor', () => {
  const inboundStart = db.indexOf('export async function processWa2LabelEvent');
  const inboundEnd = db.indexOf('export async function completeWa2LabelEventPage');
  const inbound = db.slice(inboundStart, inboundEnd);
  assert.doesNotMatch(inbound, /eventName:\s*'Converted'/);
  assert.match(read('src/historical-sync.js'), /PROTECTED_STAGE_REQUIRES_SOURCE_CONFIRMATION/);
});

test('importação reutiliza parser e upsert, preservando stage e identidade Meta', () => {
  assert.match(meta, /export async function importLeadPayload/);
  assert.match(meta, /return upsert\(/);
  assert.match(db, /input\.stage \|\| 'NEW'/);
  assert.match(worker, /importLeadPayload/);
  assert.match(db, /ON CONFLICT \(tenant_id, meta_lead_id\)/);
  assert.doesNotMatch(
    db.slice(db.indexOf('ON CONFLICT (tenant_id, meta_lead_id)'), db.indexOf('RETURNING *, (xmax')),
    /\bstage\s*=/,
  );
  assert.match(db, /NULLIF\(BTRIM\(leads\.phone\), ''\) IS NULL THEN EXCLUDED\.phone/);
  assert.match(db, /phone_normalized = COALESCE\(leads\.phone_normalized, EXCLUDED\.phone_normalized\)/);
  assert.match(db, /EXCLUDED\.name <> 'Lead Meta'/);
  assert.match(db, /meta_historical_import_items[\s\S]*ON CONFLICT \(tenant_id, import_id, meta_lead_id\)/);
});

test('importação Meta usa paginação Graph por formulário e cursor retomável', () => {
  assert.match(meta, /graphRequest\(`\$\{normalizedFormId\}\/leads`/);
  assert.match(meta, /since: since \? Math\.floor\(new Date\(since\)\.getTime\(\) \/ 1000\) : null/);
  assert.match(meta, /until: until \? Math\.floor\(new Date\(until\)\.getTime\(\) \/ 1000\) : null/);
  assert.match(meta, /payload\.paging\?\.cursors\?\.after/);
  assert.match(meta, /hasMore: Boolean\(payload\.paging\?\.next && nextCursor\)/);
  assert.match(worker, /after: run\.cursor_value/);
  assert.match(worker, /completeMetaHistoricalPage\(run\.id, page\)/);
});

test('backfill de MQL exige vínculo, binding e receipt APPLY vigente', () => {
  const start = db.indexOf('export async function backfillMetaQualifiedEvents');
  const end = db.indexOf('export async function getDashboardCounts', start);
  const source = db.slice(start, end);
  assert.match(source, /wa2_contact_links/);
  assert.match(source, /wa2_label_bindings/);
  assert.match(source, /wa2_label_event_receipts/);
  assert.match(source, /receipt\.operation = 'APPLY'/);
  assert.match(source, /removed\.operation = 'REMOVE'/);
  assert.match(source, /officialLabelEvidence: true/);
});

test('interface informa MQL não criado sem evidência WA2 e não acessa status nulo', () => {
  assert.match(server, /if \(!result\.event\)/);
  assert.match(server, /etiqueta oficial do WhatsApp não confirmada/);
});

test('reconciliação não une por telefone e protege vínculos ativos', () => {
  const start = db.indexOf('export async function completeWa2ReconciliationItem');
  const end = db.indexOf('async function finishReconciliationItem');
  const source = db.slice(start, end);
  assert.match(source, /lead_id = \$3 OR remote_chat_id = \$4/);
  assert.match(source, /unlinked_at IS NULL/);
  assert.doesNotMatch(source, /UPDATE leads SET phone/);
  assert.match(source, /reconciliation_item_id/);
});

test('painel fica após autenticação/CSRF e escapa dados', () => {
  const auth = server.indexOf('app.use(requireAuth)');
  const csrf = server.indexOf("req.method === 'POST' ? requireCsrf");
  const operations = server.indexOf("app.get('/operations'");
  assert.ok(auth >= 0 && csrf > auth && operations > csrf);
  assert.match(views, /historicalOperationsView/);
  assert.match(views, /csrfField\(csrfToken\)/);
  assert.match(views, /esc\(run\.form_id\)/);
});

test('worker mantém chamadas externas fora das funções transacionais do banco', () => {
  assert.doesNotMatch(worker, /\bBEGIN\b|\bCOMMIT\b|FOR UPDATE/);
  assert.match(worker, /listWa2LabelEvents[\s\S]*processWa2LabelEvent/);
  assert.match(worker, /listMetaFormLeadsPage[\s\S]*recordMetaHistoricalLead/);
  assert.match(worker, /getWa2ContactByPhone[\s\S]*completeWa2ReconciliationItem/);
});

test('reconciliação tenta reconstruir identidades antes de desistir de LID recuperável', () => {
  assert.match(worker, /refreshWa2Identities\(item\.remote_instance_id\)/);
  assert.match(worker, /WA2_LID_UNRESOLVED.*LID_UNRESOLVED/);
  assert.match(worker, /lidUnresolved \|\| isTemporaryWa2LabelError/);
});
