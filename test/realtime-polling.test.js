import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
const { encodeLeadChangesCursor, decodeLeadChangesCursor } = await import('../src/db.js');

test('cursor de mudanças é composto, opaco e reversível', () => {
  const encoded = encodeLeadChangesCursor('2026-08-01T23:21:15.357Z', '11111111-1111-4111-8111-111111111111');
  assert.notEqual(encoded, '2026-08-01T23:21:15.357Z');
  const decoded = decodeLeadChangesCursor(encoded);
  assert.equal(decoded.changedAt.toISOString(), '2026-08-01T23:21:15.357Z');
  assert.equal(decoded.leadId, '11111111-1111-4111-8111-111111111111');
});

test('cursor legado por timestamp continua válido e cursor inválido é rejeitado', () => {
  const decoded = decodeLeadChangesCursor('2026-08-01T23:21:15.357Z');
  assert.equal(decoded.changedAt.toISOString(), '2026-08-01T23:21:15.357Z');
  assert.throws(() => decodeLeadChangesCursor('not-a-cursor'), /INVALID_CURSOR/);
});

test('renderização compartilhada preserva fragmentos completos e identificador do lead', async () => {
  const { renderLeadRow, renderLeadCard } = await import('../src/views.js');
  const lead = { id: '11111111-1111-4111-8111-111111111111', name: '<img src=x>', stage: 'QUALIFIED', course: 'EJA', city: 'Montes', source: 'MANUAL', created_at: '2026-08-01T23:00:00Z', phone: null, email: null, wa2_labels: [{ id: '36', name: 'FEZ PROVA' }], mql_status: 'SENT', opportunity_status: null };
  const row = renderLeadRow(lead, { csrfToken: 'csrf', returnPath: '/?stage=QUALIFIED', whatsappMessage: 'Oi {{nome}}' });
  const card = renderLeadCard(lead, { csrfToken: 'csrf', returnPath: '/?stage=QUALIFIED', whatsappMessage: 'Oi {{nome}}' });
  assert.match(row, /<tr data-lead-id=/);
  assert.match(card, /<article class="lead-card" data-lead-id=/);
  assert.match(row, /FEZ PROVA/);
  assert.match(row, /value="csrf"/);
  assert.match(row, /returnTo/);
  assert.doesNotMatch(row, /<img src=x>/);
});

test('endpoint de mudanças é autenticado, sem cache e preserva filtros da página', () => {
  const source = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("app.get('/api/leads/changes'"), source.indexOf('\nfunction singleLeadFile'));
  assert.ok(source.indexOf('app.use(requireAuth)') < source.indexOf("app.get('/api/leads/changes'"));
  assert.match(route, /Cache-Control.*no-store/);
  assert.match(route, /dashboardFiltersFromQuery\(req\.query\)/);
  assert.match(route, /rowHtml: renderLeadRow/);
  assert.match(route, /cardHtml: renderLeadCard/);
  assert.match(route, /removed: true/);
  assert.doesNotMatch(route, /max\s*\(status\)/i);
  const dbSource = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const changesQuery = dbSource.slice(dbSource.indexOf('export async function listLeadChangesSince'), dbSource.indexOf('export async function getTenantWhatsAppMessage'));
  assert.match(changesQuery, /wa2_inbound_label_actions/);
  assert.match(changesQuery, /wa2_label_event_receipts/);
  assert.match(changesQuery, /changed_at/);
});

test('polling envia os filtros atuais e não recarrega a página', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const polling = source.slice(source.indexOf('function setupLeadChangesPolling'), source.indexOf('\nsetupLeadChangesPolling();'));
  assert.match(polling, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(polling, /query\.set\('cursor'/);
  assert.match(polling, /cache: 'no-store'/);
  assert.doesNotMatch(polling, /window\.location\.reload/);
});

test('filtro WhatsApp separa oficiais, externas, ausência e REMOVE vigente', () => {
  const dbSource = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(dbSource, /WA2_EXTERNAL_LABEL_FILTER = '__external__'/);
  assert.match(dbSource, /WA2_NO_EXTERNAL_LABEL_FILTER = '__none__'/);
  assert.match(dbSource, /binding\.id IS NULL/);
  assert.match(dbSource, /NOT \$\{exists\}/);
  assert.match(dbSource, /removed\.operation = 'REMOVE'/);
  const views = fs.readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
  assert.match(views, /<label>Etiqueta WhatsApp<select name="labelId">/);
  assert.match(views, /Com qualquer etiqueta externa/);
  assert.match(views, /Sem etiquetas externas/);
  assert.match(views, /Etapas CRM/);
  assert.match(views, /Etiquetas complementares/);
});
