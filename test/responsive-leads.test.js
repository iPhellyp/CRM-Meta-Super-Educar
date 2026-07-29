import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dashboardView } from '../src/views.js';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

const counts = {
  total: 2,
  new: 1,
  unattended: 1,
  no_response: 1,
  in_service: 0,
  qualified: 0,
  opportunities: 1,
  awaiting_enrollment: 1,
  awaiting_payment: 0,
  enrolled: 0,
  paid: 0,
  lost: 0,
  qualificationRate: 50,
  matriculationRate: 0,
  metaPending: 0,
  metaRetry: 0,
  metaFailed: 1,
};

function render(overrides = {}) {
  return dashboardView({
    leads: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Lead com nome extremamente longo que precisa quebrar sem estourar o cartão',
      phone: '(38) 99114-2298',
      phone_normalized: '5538991142298',
      email: 'lead@example.com',
      course: 'Curso Superior de Tecnologia com um nome propositalmente muito extenso',
      city: 'Cidade com um nome bastante longo para validar quebra de linha',
      source: 'META_INSTANT_FORM',
      stage: 'NEW',
      received_at: '2026-07-29T15:30:00.000Z',
      meta_lead_id: '00012345678901234567890',
      meta_campaign_id: 'campaign-1',
      meta_adset_id: 'adset-1',
      meta_ad_id: 'ad-1',
      meta_form_name: 'Formulário principal',
    }, {
      id: '22222222-2222-4222-8222-222222222222',
      name: '<script>alert(1)</script>',
      phone: null,
      course: null,
      city: null,
      source: 'MANUAL',
      stage: 'NO_RESPONSE',
      received_at: '2026-07-29T16:30:00.000Z',
    }],
    counts,
    metaStatus: { configured: true, graphVersion: 'v25.0', testMode: false, missing: [] },
    filters: { search: 'Ana & Bia', city: 'Montes Claros', stage: 'NEW', sort: 'recent' },
    pagination: { page: 2, hasNext: true },
    wa2Instances: [],
    metaConnections: [],
    whatsappMessage: 'Olá, {{nome}}!',
    csrfToken: '<csrf>',
    ...overrides,
  });
}

test('desktop usa tabela compacta de seis colunas e detalhes progressivos', () => {
  const html = render();
  const tableHead = html.slice(
    html.indexOf('<table class="leads-table">'),
    html.indexOf('</thead>', html.indexOf('<table class="leads-table">')),
  );
  for (const heading of [
    'Selecionar', 'Lead', 'Curso e cidade', 'Origem e chegada', 'Etapa', 'Ações',
  ]) assert.match(tableHead, new RegExp(heading));
  assert.doesNotMatch(tableHead, /Campanha|Página\/formulário|BM|WA2/);
  assert.match(html, /<summary>Detalhes da origem<\/summary>/);
  assert.match(html, /class="table-wrap desktop-leads"/);
});

test('mobile e tablet usam cards com os mesmos links diretos do WhatsApp', () => {
  const html = render();
  assert.equal((html.match(/class="lead-card"/g) || []).length, 2);
  assert.equal((html.match(/data-whatsapp-link/g) || []).length, 2);
  assert.equal((
    html.match(/data-whatsapp-log-url="\/leads\/11111111-1111-4111-8111-111111111111\/whatsapp-opened"/g) || []
  ).length, 2);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
  assert.doesNotMatch(html, /data-whatsapp-form/);
  assert.match(html, /Sem telefone/);
  assert.match(html, /Abrir no WhatsApp/);
  assert.match(html, /Atualizar etapa/);
  assert.match(html, /Mais ações/);
  assert.match(html, /aria-labelledby="lead-card-11111111-1111-4111-8111-111111111111"/);
});

test('filtros mantêm busca rápida, drawer, resumo, limpeza e paginação', () => {
  const html = render();
  assert.match(html, /role="search"/);
  assert.match(html, /id="lead-search"/);
  assert.match(html, /data-filter-open aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="advanced-filters"/);
  assert.match(html, /Filtros aplicados:/);
  assert.match(html, /Busca: Ana &amp; Bia/);
  assert.match(html, /Cidade: Montes Claros/);
  assert.match(html, /Etapa: NEW/);
  assert.match(html, /href="\/"/);
  assert.match(html, /search=Ana\+%26\+Bia&amp;city=Montes\+Claros&amp;stage=NEW/);
  assert.match(html, /Página 2/);
});

test('navegação agrupada tem drawer, saída separada e nomes acessíveis', () => {
  const html = render();
  for (const group of ['Operação', 'Integrações', 'Monitoramento', 'Configurações']) {
    assert.match(html, new RegExp(`>${group}<`));
  }
  assert.match(html, /aria-label="Navegação principal"/);
  assert.match(html, /data-nav-toggle aria-expanded="false"/);
  assert.match(html, /data-nav-close aria-label="Fechar menu"/);
  assert.match(html, /class="nav-logout"/);
  assert.match(html, /name="_csrf" value="&lt;csrf&gt;"/);
});

test('dashboard prioriza trabalho pendente e recolhe formulários administrativos', () => {
  const html = render();
  const priorities = html.slice(html.indexOf('priority-stats'), html.indexOf('</section>', html.indexOf('priority-stats')));
  const labels = [
    'Sem atendimento', 'Leads novos', 'Sem resposta', 'Oportunidades',
    'Aguardando matrícula', 'Aguardando pagamento', 'Falhas de integração',
  ];
  let previous = -1;
  for (const label of labels) {
    const index = priorities.indexOf(label);
    assert.ok(index > previous, `${label} deve respeitar a prioridade visual`);
    previous = index;
  }
  assert.match(html, /<details class="panel dashboard-tool" id="lead-tools">/);
  assert.match(html, /<details class="panel dashboard-tool" id="whatsapp-settings">/);
});

test('XSS, CSRF, perda e retorno seguro permanecem no markup', () => {
  const html = render();
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok((html.match(/name="_csrf" value="&lt;csrf&gt;"/g) || []).length > 5);
  assert.match(html, /id="lost-dialog"/);
  assert.match(html, /name="returnTo" value="\/\?search=Ana\+%26\+Bia&amp;city=Montes\+Claros&amp;stage=NEW/);
});

test('CSS cobre viewports pedidos sem tabela larga no mobile', async () => {
  const css = await read('public/app.css');
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /@media \(min-width: 768px\)/);
  assert.match(css, /@media \(min-width: 1024px\)/);
  assert.match(css, /@media \(min-width: 1440px\)/);
  assert.match(css, /\.desktop-leads \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 1024px\)[\s\S]*\.desktop-leads \{ display: block;/);
  assert.doesNotMatch(css, /\.leads-table\s*\{[^}]*min-width:\s*1680px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /--control-height-mobile:\s*48px/);
});

test('JavaScript implementa Escape, focus trap, inert e retorno de foco', async () => {
  const app = await read('public/app.js');
  assert.match(app, /function setupNavigationDrawer/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /main\.inert = true/);
  assert.match(app, /main\.inert = false/);
  assert.match(app, /toggle\.focus\(\)/);
  assert.match(app, /function setupFilterDrawer/);
  assert.match(app, /dialog\.showModal\(\)/);
  assert.match(app, /opener\.focus\(\)/);
});

test('backend conta prioridades e só aceita retorno para a raiz local', async () => {
  const [database, server] = await Promise.all([read('src/db.js'), read('src/server.js')]);
  assert.match(database, /stage = 'NEW' AND first_contact_at IS NULL/);
  assert.match(database, /stage = 'NO_RESPONSE'/);
  assert.match(database, /stage = 'AWAITING_ENROLLMENT'/);
  assert.match(database, /stage = 'AWAITING_PAYMENT'/);
  assert.match(server, /function safeDashboardReturnPath/);
  assert.match(server, /url\.origin === 'http:\/\/dashboard\.local' && url\.pathname === '\/'/);
  assert.match(server, /safeDashboardReturnPath\(req\.body\.returnTo\)/);
});
