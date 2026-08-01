import {
  LOST_REASON_LABELS,
  STAGE_LABELS,
  STAGES,
  getStageActions,
  getStageBadgeClass,
} from './funnel.js';
import { getWhatsAppUrl, selectBestLeadPhone } from './phone.js';
import {
  WA2_LABEL_STAGES,
  getWa2StageLabelName,
  normalizeWa2LabelName,
} from './wa2-label-sync.js';

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function csrfField(csrfToken) {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;
}

const HIDDEN_WA2_LABELS = new Set(['Favoritos', 'Não lidas', 'Grupos', 'GERAL', 'SALAS ALUGAR']);
function wa2Labels(lead, { compact = false } = {}) {
  const labels = Array.isArray(lead.wa2_labels) ? lead.wa2_labels : [];
  const visible = labels.filter((label) => label?.name && (!compact || !HIDDEN_WA2_LABELS.has(label.name)));
  const shown = compact ? visible.slice(0, 3) : visible;
  const extra = visible.length - shown.length;
  return `${shown.map((label) => `<span class="wa2-tag">${esc(label.name)}</span>`).join('')}${extra > 0 ? `<span class="wa2-tag wa2-tag-more">+${extra}</span>` : ''}` || '<span class="muted">Sem etiquetas externas</span>';
}

function metaEventBadge(label, status, attributable) {
  if (!attributable) return `<span class="meta-status muted">${esc(label)} não atribuível</span>`;
  const text = status === 'SENT' ? 'enviado' : status === 'FAILED' ? 'falhou' : status ? 'pendente' : 'não criado';
  return `<span class="meta-status meta-${String(status || 'pending').toLowerCase()}">${esc(label)} ${text}</span>`;
}

function metaStatusMarkup(lead) {
  const attributable = Boolean(lead.meta_lead_id);
  const mql = metaEventBadge('MQL', lead.mql_status, attributable);
  const opportunity = ['NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT'].includes(lead.stage)
    ? metaEventBadge('Sales Opportunity', lead.opportunity_status, attributable) : '';
  return `<div class="meta-statuses">${mql}${opportunity}</div>`;
}

const ICON_PATHS = Object.freeze({
  whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-4.6A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.5 8.5c.5 3 2 4.5 5 5l1.5-1.5 2 1v2c0 1-1 2-2 2A10 10 0 0 1 7 9c0-1 1-2 2-2h2l1 2-1.5 1.5"/>',
  stage: '<path d="M4 7h10"/><path d="m11 4 3 3-3 3"/><path d="M20 17H10"/><path d="m13 14-3 3 3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  details: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
  wa2: '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M16 3h5v5"/>',
  close: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  x: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
});

function icon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function appNavigation(csrfToken) {
  return `<div class="app-brand"><strong>CRM Meta</strong><span>Super Educar</span></div>
    <button type="button" class="nav-toggle" data-nav-toggle aria-expanded="false"
      aria-controls="app-navigation" aria-label="Abrir menu principal">${icon('menu')}</button>
    <nav aria-label="Navegação principal" id="app-navigation" class="app-navigation" data-nav-drawer>
      <div class="nav-drawer-header"><strong>Menu principal</strong>
        <button type="button" class="nav-close" data-nav-close aria-label="Fechar menu">${icon('x')}</button>
      </div>
      <div class="nav-groups">
        <a class="nav-direct" href="/">Leads</a>
        <details class="nav-group">
          <summary>Operação</summary>
          <div class="nav-group-links"><a href="/operations">Importações</a>
            <a href="/operations#reconciliacoes">Reconciliações</a></div>
        </details>
        <details class="nav-group">
          <summary>Integrações</summary>
          <div class="nav-group-links"><a href="/meta/connections">Meta</a><a href="/wa2">WhatsApp</a>
            <a href="/wa2/labels">Etiquetas</a></div>
        </details>
        <details class="nav-group">
          <summary>Monitoramento</summary>
          <div class="nav-group-links"><a href="/events">Eventos Meta</a><a href="/wa2/label-jobs">Jobs WA2</a>
            <a href="/events?status=FAILED">Falhas</a></div>
        </details>
        <details class="nav-group">
          <summary>Configurações</summary>
          <div class="nav-group-links"><a href="/#whatsapp-settings">Mensagens</a>
            <a href="/meta/connections">Conexões</a><a href="/#lead-tools">Preferências</a></div>
        </details>
      </div>
      <form method="post" action="/logout" class="nav-logout" data-pwa-logout>
        ${csrfField(csrfToken)}<button class="link">Sair</button>
      </form>
    </nav>
    <button type="button" class="nav-backdrop" data-nav-backdrop
      aria-label="Fechar menu" tabindex="-1"></button>`;
}

function layout(title, body, { logged = true, csrfToken = '' } = {}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#35165f">
  <title>${esc(title)} · CRM Super Educar</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/app-icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/app-icon-192.png">
  <link rel="stylesheet" href="/app.css?v=12">
  <script src="/app.js?v=12" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Ir para o conteúdo principal</a>
  ${logged ? `<header class="app-header">${appNavigation(csrfToken)}</header>` : ''}
  <main id="main-content">${body}</main>
  <aside class="pwa-shell" aria-label="Aplicativo">
    <div class="pwa-notice" data-pwa-install-panel hidden role="status">
      <span>Instale o CRM para abrir como aplicativo.</span>
      <button type="button" class="small" data-pwa-install>Instalar</button>
      <button type="button" class="link" data-pwa-install-dismiss>Agora não</button>
    </div>
    <div class="pwa-notice" data-pwa-ios hidden role="status">
      <span>No iPhone, use Compartilhar e “Adicionar à Tela de Início”.</span>
      <button type="button" class="link" data-pwa-dismiss>Dispensar</button>
    </div>
    <div class="pwa-notice" data-pwa-update hidden role="status">
      <span>Uma nova versão está disponível.</span>
      <button type="button" class="small" data-pwa-reload>Recarregar quando for seguro</button>
    </div>
    <div class="pwa-notice offline" data-connection-status hidden role="status">
      Sem conexão. As telas administrativas não são armazenadas offline.
    </div>
  </aside>
</body>
</html>`;
}

export function loginView(error = '', csrfToken = '') {
  return layout('Entrar', `
    <section class="login-card">
      <h1>CRM Meta</h1>
      <p>Bridge de leads qualificados e matrículas.</p>
      ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
      <form method="post" action="/login" class="stack">
        ${csrfField(csrfToken)}
        <label>E-mail<input name="email" type="email" required autocomplete="username"></label>
        <label>Senha<input name="password" type="password" required autocomplete="current-password"></label>
        <button type="submit">Entrar</button>
      </form>
    </section>`, { logged: false });
}

function stat(label, value, className = '') {
  return `<div class="stat ${esc(className)}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function operationDuration(startedAt, completedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}min ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return esc(new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date).replace(',', ' às'));
}

function operationStatus(status) {
  const labels = {
    REQUESTED: 'Solicitada',
    PENDING: 'Na fila',
    RETRY: 'Nova tentativa',
    PROCESSING: 'Processando',
    RUNNING: 'Processando',
    PREVIEW: 'Aguardando confirmação',
    COMPLETED: 'Concluída',
    DONE: 'Concluído',
    PARTIAL: 'Concluída com pendências',
    PAUSED: 'Pausada',
    CANCELLED: 'Cancelada',
    FAILED: 'Falhou',
    VALID: 'Válida',
    INVALID: 'Inválida',
    ERROR: 'Erro',
  };
  return `<span class="badge ${statusClass(status)}">${esc(labels[status] || status || 'Indisponível')}</span>`;
}

const reconciliationErrorLabels = {
  CONTACT_NOT_FOUND: 'Não encontrado no WA2',
  WA2_CONTACT_NOT_FOUND: 'Não encontrado no WA2',
  WA2_LID_UNRESOLVED: 'LID não resolvido',
  LID_UNRESOLVED: 'LID não resolvido',
  CONTACT_AMBIGUOUS: 'Conflito',
  WA2_CONTACT_AMBIGUOUS: 'Conflito',
  WA2_AUTHENTICATION_FAILED: 'Erro de autenticação/configuração',
  WA2_AUTHORIZATION_FAILED: 'Erro de autenticação/configuração',
  WA2_RATE_LIMITED: 'Limite do WA2',
  WA2_TEMPORARY_FAILURE: 'Falha temporária do WA2',
  WA2_API_ROUTE_NOT_FOUND: 'Incompatibilidade de API',
};

function operationProgress(processed, total, label = 'Progresso') {
  const safeProcessed = Math.max(0, Number(processed) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const percent = safeTotal ? Math.min(100, Math.round((safeProcessed / safeTotal) * 100)) : 0;
  return `<div class="operation-progress">
    <div class="progress-label"><span>${esc(label)}</span><strong>${safeProcessed}/${safeTotal}</strong></div>
    <div class="progress-track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0"
      aria-valuemax="${safeTotal}" aria-valuenow="${safeProcessed}">
      <span style="width:${percent}%"></span>
    </div>
  </div>`;
}

export function historicalOperationsView({
  operations,
  instances,
  metaForms = [],
  message = '',
  error = '',
  csrfToken = '',
}) {
  const cursor = operations.cursor;
  const enabledInstances = instances.filter((item) => item.enabled);
  const openReconciliations = operations.reconciliations.filter(
    (run) => !['COMPLETED', 'CANCELLED'].includes(run.status),
  ).length;
  const reconciliationFailures = operations.reconciliations.reduce(
    (total, run) => total + Number(run.results?.ERROR || 0) + Number(run.results?.CONFLICT || 0),
    0,
  );
  const resultLabels = {
    MATCHED: 'Correspondências encontradas',
    UPDATED: 'Leads atualizados',
    PHONE_EMPTY: 'Telefone vazio',
    PHONE_INVALID: 'Telefone inválido',
    NOT_FOUND_IN_WA2: 'Não encontrado no WA2',
    LID_UNRESOLVED: 'LID não resolvido',
    LABEL_UNMAPPED: 'Etiqueta sem vínculo',
    CONFLICT: 'Conflito',
    ERROR: 'Erro',
  };
  return layout('Importação e reconciliação', `
    <section class="hero"><div><h1>Importações e reconciliações</h1>
      <p>Acompanhe operações em lote sem perder o contexto comercial dos leads.</p></div></section>
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="stats operation-summary" aria-label="Resumo operacional">
      ${stat('Importações Meta', operations.imports.length)}
      ${stat('Arquivos enviados', (operations.fileImports || []).length)}
      ${stat('Reconciliações abertas', openReconciliations)}
      ${stat('Falhas ou conflitos', reconciliationFailures, reconciliationFailures ? 'attention' : '')}
    </section>
    <div class="operation-columns">
      <section class="panel operation-source meta-source">
        <div class="panel-title"><div><span class="eyebrow">Direto da integração</span>
          <h2>Importar diretamente da Meta</h2><p>Escolha formulários válidos e, se necessário, limite o período.</p></div>
          <span class="badge contact-started">Meta</span></div>
        ${metaForms.length ? `<form method="post" action="/operations/meta-imports" class="stack" data-required-selection>
          ${csrfField(csrfToken)}
          <fieldset class="selection-list"><legend>Formulários disponíveis</legend>
            ${metaForms.map((form) => `<label class="selection-option">
              <input type="checkbox" name="formRecordIds" value="${esc(form.id)}">
              <span><strong>${esc(form.name)}</strong>
                <small>${esc(form.connection_name)} · ${esc(form.page_name)}</small></span>
            </label>`).join('')}
          </fieldset>
          <p class="selection-feedback" data-selection-feedback role="status">Selecione ao menos um formulário.</p>
          <div class="date-range">
            <label>Início do período<input type="date" name="periodStart"></label>
            <label>Fim do período<input type="date" name="periodEnd"></label>
          </div>
          <button type="submit" data-selection-submit>Iniciar importação</button>
        </form>` : `<div class="empty-state"><h3>Nenhum formulário disponível</h3>
          <p>Adicione e valide uma conexão, uma página e um formulário Meta antes de importar.</p>
          <a class="button-link" href="/meta/connections">Configurar Meta</a></div>`}
      </section>
      <section class="panel operation-source file-source">
        <div class="panel-title"><div><span class="eyebrow">Arquivo controlado</span>
          <h2>Importar arquivo de leads</h2><p>CSV, XLSX ou XLS da Meta · até 5 MB, 2.000 linhas e 50 colunas.</p></div>
          <span class="badge qualified">Arquivo</span></div>
        <ol class="import-steps" aria-label="Etapas da importação">
          <li class="active">1 <span>Arquivo</span></li><li>2 <span>Conferência</span></li><li>3 <span>Resultado</span></li>
        </ol>
        <form method="post" action="/operations/file-imports/preview"
          enctype="multipart/form-data" class="stack upload-dropzone">
          ${csrfField(csrfToken)}
          <label><strong>Arraste o arquivo aqui ou selecione no dispositivo</strong>
            <span>CSV, XLSX, XLS binário e Excel XML · até 5 MB</span>
            <input type="file" name="leadFile" accept=".csv,.xlsx,.xls" required>
          </label>
          <button type="submit">Gerar prévia segura</button>
        </form>
        <p class="helper-text">A prévia não altera leads. Duplicidades possíveis nunca são mescladas automaticamente.</p>
      </section>
    </div>
    <section class="panel">
      <div class="panel-title"><div><h2>Histórico de importações</h2>
        <p>Operações diretas e por arquivo aparecem separadas.</p></div>
        <span>${operations.imports.length + (operations.fileImports || []).length} registros</span></div>
      <div class="operation-card-list">
        ${operations.imports.map((run) => `<article class="operation-card meta-operation">
          <header><div><span class="eyebrow">Meta · formulário</span><h3>${esc(run.form_name || run.form_id)}</h3></div>${operationStatus(run.status)}</header>
          <div class="metric-grid compact">
            ${stat('Recebidos', run.received_count || 0)}${stat('Criados', run.created_count || 0)}
            ${stat('Atualizados', run.updated_count || 0)}${stat('Inválidos', run.invalid_count || 0)}
          </div>
          <details class="technical-details"><summary>Detalhes técnicos</summary>
            <dl><div><dt>ID da operação</dt><dd>${esc(run.id)}</dd></div>
              <div><dt>ID do formulário</dt><dd>${esc(run.form_id)}</dd></div>
              <div><dt>Cursor</dt><dd>${detailValue(run.cursor_value)}</dd></div></dl></details>
          <div class="actions">
            ${['PAUSED', 'FAILED'].includes(run.status) ? `<form method="post" action="/operations/meta-imports/${esc(run.id)}/resume">${csrfField(csrfToken)}<button>Retomar</button></form>` : ''}
            ${['PENDING', 'PAUSED'].includes(run.status) ? `<form method="post" action="/operations/meta-imports/${esc(run.id)}/cancel" data-confirm="Cancelar esta importação Meta?">${csrfField(csrfToken)}<button class="danger">Cancelar</button></form>` : ''}
          </div>
        </article>`).join('')}
        ${(operations.fileImports || []).map((run) => `<article class="operation-card file-operation">
          <header><div><span class="eyebrow">Arquivo · ${esc(run.format)}</span><h3>${esc(run.original_filename)}</h3>
            <small>Planilha: ${esc(run.sheet_name)}</small></div>${operationStatus(run.status)}</header>
          ${operationProgress(run.applied_count, run.total_count, 'Linhas aplicadas')}
          <p class="muted">Criada em ${formatDateTime(run.created_at)}</p>
        </article>`).join('')}
        ${!operations.imports.length && !(operations.fileImports || []).length
          ? '<div class="empty-state"><h3>Nenhuma importação ainda</h3><p>Inicie pela Meta ou envie uma planilha para acompanhar o processamento aqui.</p></div>'
          : ''}
      </div>
    </section>
    <section class="panel">
      <div class="panel-title"><div><h2>Eventos WhatsApp</h2><p>Atividade recebida e classificada pelo cursor.</p></div>
        ${operationStatus(cursor?.status || 'PENDING')}</div>
      <div class="metric-grid">
        ${stat('Processados', cursor?.processed_count || 0)}
        ${stat('Pendentes', cursor?.pending_count || 0)}
        ${stat('Conflitos', cursor?.conflict_count || 0, cursor?.conflict_count ? 'attention' : '')}
        ${stat('Ignorados', cursor?.ignored_count || 0, 'secondary-stat')}
      </div>
      ${cursor?.last_error_code ? `<div class="alert error"><strong>Último erro:</strong> ${esc(cursor.last_error_code)}</div>` : ''}
      <details class="technical-details"><summary>Cursor e detalhes técnicos</summary>
        <dl><div><dt>Cursor atual</dt><dd>${esc(cursor?.cursor_value || 'Inicial')}</dd></div>
          <div><dt>Atividade</dt><dd>${formatDateTime(cursor?.updated_at || cursor?.last_processed_at)}</dd></div></dl>
      </details>
    </section>
    <section class="panel" id="reconciliacoes">
      <div class="panel-title"><div><h2>Reconciliação WA2</h2>
        <p>Compare os leads do CRM com uma instância WhatsApp validada.</p></div>
        <span>${openReconciliations} abertas</span></div>
      ${enabledInstances.length ? `<form method="post" action="/operations/reconciliations" class="compact-form stack">
        ${csrfField(csrfToken)}
        <label>Instância<select name="instanceId" required><option value="">Selecione uma instância</option>
          ${enabledInstances.map((item) =>
            `<option value="${esc(item.id)}">${esc(item.name || item.remote_instance_id)}${item.is_default ? ' · padrão' : ''}</option>`).join('')}
        </select></label><button type="submit">Iniciar reconciliação</button>
      </form>` : `<div class="empty-state"><h3>Nenhuma instância habilitada</h3>
        <p>Valide e habilite uma instância WA2 antes de iniciar a reconciliação.</p>
        <a class="button-link" href="/wa2">Configurar WhatsApp</a></div>`}
      <div class="operation-card-list reconciliation-list">
        ${operations.reconciliations.map((run) => `<article class="operation-card reconciliation-card">
          <header><div><span class="eyebrow">Reconciliação WA2</span><h3>${esc(run.instance_name)}</h3>
            <small>Criada em ${formatDateTime(run.created_at)}</small></div>${operationStatus(run.status)}</header>
          ${operationProgress(run.processed_count, run.total_count)}
          <p class="muted">Duração: ${esc(operationDuration(run.started_at, run.completed_at))} · ${esc(run.retry_count || 0)} nova(s) tentativa(s)</p>
          ${run.last_error ? `<div class="alert error">${esc(run.last_error)}</div>` : ''}
          <div class="result-groups">
            ${Object.entries(run.results || {}).map(([result, count]) => `<a href="/operations/reconciliations/${esc(run.id)}/items?result=${esc(result)}">
              <strong>${esc(count)}</strong><span>${esc(resultLabels[result] || result)}</span></a>`).join('')
              || '<p class="muted">Os resultados aparecerão após o início do processamento.</p>'}
          </div>
          <div class="actions">
            <a class="button-link secondary small" href="/operations/reconciliations/${esc(run.id)}/errors.csv">Exportar erros CSV</a>
            ${['PARTIAL', 'FAILED'].includes(run.status) ? `<form method="post" action="/operations/reconciliations/${esc(run.id)}/retry"
              data-confirm="Enfileirar novamente somente as falhas elegíveis desta reconciliação?">
              ${csrfField(csrfToken)}<button>Enfileirar falhas</button></form>` : ''}
          </div>
          <details class="technical-details"><summary>Detalhes técnicos</summary><dl>
            <div><dt>ID da operação</dt><dd>${esc(run.id)}</dd></div>
            <div><dt>Início</dt><dd>${formatDateTime(run.started_at)}</dd></div>
            <div><dt>Fim</dt><dd>${formatDateTime(run.completed_at)}</dd></div>
          </dl></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhuma reconciliação</h3><p>Selecione uma instância para iniciar o primeiro lote.</p></div>'}
      </div>
    </section>
    <section class="panel"><h2>Conflitos abertos</h2><ul>
      ${operations.conflicts.map((item) =>
        `<li>${esc(item.conflict_type)} — ${item.lead_id ? `<a href="/leads/${esc(item.lead_id)}">${esc(item.lead_name || item.lead_id)}</a>` : 'sem lead'}</li>`).join('') || '<li>Nenhum.</li>'}
    </ul></section>
    <section class="panel"><h2>Solicitações antigas de matrícula</h2><ul>
      ${operations.confirmations.map((item) => `<li>${esc(item.lead_name)}
        <a href="/leads/${esc(item.lead_id)}">Abrir lead</a>
        <form method="post" action="/operations/confirmations/${esc(item.id)}/reject">${csrfField(csrfToken)}<button>Rejeitar</button></form>
      </li>`).join('') || '<li>Nenhuma.</li>'}
    </ul></section>
  `, { csrfToken });
}

export function leadFileSheetSelectionView({
  sheets = [],
  error = '',
  csrfToken = '',
}) {
  return layout('Selecionar planilha', `
    <section class="hero"><div><h1>Selecionar planilha</h1>
      <p>O arquivo contém mais de uma planilha com dados.</p></div></section>
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="panel">
      <h2>Enviar novamente com a planilha escolhida</h2>
      <p>Por segurança, o arquivo anterior já foi descartado e não foi salvo.</p>
      <form method="post" action="/operations/file-imports/preview"
        enctype="multipart/form-data" class="stack">
        ${csrfField(csrfToken)}
        <label>Planilha<select name="sheetName" required>
          ${sheets.map((sheet) => `<option value="${esc(sheet)}">${esc(sheet)}</option>`).join('')}
        </select></label>
        <label>Arquivo<input type="file" name="leadFile" accept=".csv,.xlsx,.xls" required></label>
        <button type="submit">Gerar prévia</button>
      </form>
    </section>
    <div class="actions"><a class="button-link secondary" href="/operations">Cancelar</a></div>
  `, { csrfToken });
}

export function leadFileImportPreviewView({ imported, csrfToken = '' }) {
  const decisionLabels = {
    NEW: 'Novo',
    UPDATE: 'Atualizar pelo ID Meta',
    POSSIBLE_DUPLICATE: 'Possível duplicidade',
    INVALID: 'Inválido',
  };
  const previewItems = Array.isArray(imported.items)
    ? imported.items
    : [];
  const diagnostics = imported.importDiagnostics || {};
  const delimiterLabel = diagnostics.delimiter === '\t'
    ? 'Tabulação'
    : diagnostics.delimiter === ';' ? 'Ponto e vírgula'
      : diagnostics.delimiter === ',' ? 'Vírgula' : 'Não aplicável';
  return layout('Prévia da importação', `
    <section class="hero"><div><h1>Prévia da importação</h1>
      <p>Nenhum lead foi alterado. Confira as decisões antes de confirmar.</p></div></section>
    <section class="panel">
      <ol class="import-steps" aria-label="Etapas da importação">
        <li>1 <span>Arquivo</span></li><li class="active">2 <span>Conferência</span></li><li>3 <span>Resultado</span></li>
      </ol>
      ${(diagnostics.warnings || []).map((warning) => `<div class="alert warning">${esc(warning)}</div>`).join('')}
      <div class="detail-grid">
        <div><strong>Arquivo</strong><span>${esc(imported.original_filename)}</span></div>
        <div><strong>Formato</strong><span>${esc(imported.format)}</span></div>
        ${diagnostics.detectedFormat ? `<div><strong>Formato detectado</strong><span>${esc(diagnostics.detectedFormat)}</span></div>` : ''}
        ${diagnostics.encoding ? `<div><strong>Codificação</strong><span>${esc(diagnostics.encoding)}</span></div>` : ''}
        ${diagnostics.delimiter ? `<div><strong>Delimitador</strong><span>${esc(delimiterLabel)}</span></div>` : ''}
        <div><strong>Planilha</strong><span>${esc(imported.sheet_name)}</span></div>
        <div><strong>SHA-256</strong><span class="break-anywhere">${esc(imported.sha256)}</span></div>
      </div>
      <div class="metrics">
        <article><span>Total</span><strong>${esc(imported.counts.total)}</strong></article>
        <article><span>Novos</span><strong>${esc(imported.counts.new)}</strong></article>
        <article><span>Atualizações</span><strong>${esc(imported.counts.update)}</strong></article>
        <article><span>Possíveis duplicidades</span><strong>${esc(imported.counts.possibleDuplicate)}</strong></article>
        <article><span>Inválidos</span><strong>${esc(imported.counts.invalid)}</strong></article>
      </div>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Todas as linhas</h2><span>${esc(previewItems.length)} linhas exibidas</span></div>
      <div class="table-wrap"><table><thead><tr><th>Linha</th><th>ID Meta</th><th>Nome</th>
        <th>WhatsApp</th><th>Data Meta</th><th>Decisão</th><th>Validação</th></tr></thead><tbody>
        ${previewItems.length ? previewItems.map((item) => `<tr>
          <td>${esc(item.row_number)}</td><td>${detailValue(item.meta_lead_id)}</td>
          <td>${detailValue(item.name)}</td><td>${detailValue(item.phone_normalized || item.phone)}</td>
          <td>${formatDateTime(item.meta_created_at)}</td>
          <td><span class="badge ${esc(item.decision.toLowerCase().replaceAll('_', '-'))}">${esc(decisionLabels[item.decision] || item.decision)}</span></td>
          <td>${item.errors?.length ? esc(item.errors.join(', ')) : 'Válido'}</td>
        </tr>`).join('') : '<tr><td colspan="7">Nenhuma linha disponível para exibição.</td></tr>'}
      </tbody></table></div>
      ${imported.status === 'PREVIEW' ? `<div class="actions">
        <form method="post" action="/operations/file-imports/${esc(imported.id)}/confirm"
          data-confirm="Confirmar a importação dos leads válidos?">
          ${csrfField(csrfToken)}
          <input type="hidden" name="confirmation" value="CONFIRM_LEAD_FILE_IMPORT">
          <button type="submit">Confirmar importação</button>
        </form>
        <form method="post" action="/operations/file-imports/${esc(imported.id)}/cancel">
          ${csrfField(csrfToken)}
          <button type="submit" class="secondary">Cancelar</button>
        </form>
      </div>` : `<div class="alert success">Esta importação já foi processada.</div>
        <div class="actions"><a class="button-link secondary" href="/operations">Voltar</a></div>`}
    </section>
  `, { csrfToken });
}

export function reconciliationItemsView({
  runId,
  result = '',
  items = [],
  csrfToken = '',
}) {
  const labels = {
    MATCHED: 'Correspondência encontrada',
    UPDATED: 'Lead atualizado',
    PHONE_EMPTY: 'Telefone vazio',
    PHONE_INVALID: 'Telefone inválido',
    NOT_FOUND_IN_WA2: 'Não encontrado no WA2',
    LID_UNRESOLVED: 'LID não resolvido',
    LABEL_UNMAPPED: 'Etiqueta sem vínculo',
    CONFLICT: 'Conflito',
    ERROR: 'Erro',
  };
  return layout('Registros da reconciliação', `
    <section class="hero"><div><h1>Registros da reconciliação</h1><p>Job ${esc(runId)}${result ? ` · ${esc(labels[result] || result)}` : ''}</p></div></section>
    <section class="panel">
      <div class="panel-title"><h2>Registros</h2><span>${items.length} exibidos</span></div>
      <div class="table-wrap"><table><thead><tr><th>Lead</th><th>Resultado</th><th>Tentativas</th><th>Erro sanitizado</th><th>Finalizado</th></tr></thead><tbody>
        ${items.map((item) => `<tr><td><a href="/leads/${esc(item.lead_id)}">${esc(item.lead_name)}</a><small>${esc(item.lead_id)}</small></td><td>${esc(labels[item.result] || item.result || 'Pendente')}</td><td>${esc(item.attempts)}</td><td>${detailValue(reconciliationErrorLabels[item.last_error_code] || item.last_error_code)}</td><td>${formatDateTime(item.finished_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum registro.</td></tr>'}
      </tbody></table></div>
    </section>
    <div class="actions"><a class="button-link secondary" href="/operations">Voltar</a><a class="button-link" href="/operations/reconciliations/${esc(runId)}/errors.csv">Exportar erros CSV</a></div>
  `, { csrfToken });
}

function strictWhatsAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'wa.me' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? url.toString()
      : '';
  } catch {
    return '';
  }
}

function whatsappAction(lead, csrfToken, whatsappMessage) {
  const phone = selectBestLeadPhone(lead);
  if (!phone.phoneNormalized) {
    return `
      <button type="button" class="action-button whatsapp" disabled>
        ${icon('whatsapp')}<span>Abrir no WhatsApp</span>
      </button>
      <p class="action-status error-text" role="alert">${icon('alert')} Telefone inválido</p>`;
  }
  const message = String(whatsappMessage || '').replaceAll(
    '{{nome}}',
    String(lead.name || '').trim(),
  );
  const whatsappUrl = strictWhatsAppUrl(getWhatsAppUrl(phone.phoneNormalized, message));
  if (!whatsappUrl) {
    return `<button type="button" class="action-button whatsapp" disabled>
      ${icon('whatsapp')}<span>Abrir no WhatsApp</span>
    </button>`;
  }
  return `<div>
    <a class="action-button whatsapp primary-action" href="${esc(whatsappUrl)}"
      target="_blank" rel="noopener noreferrer" data-whatsapp-link
      data-whatsapp-log-url="/leads/${esc(lead.id)}/whatsapp-opened"
      data-whatsapp-csrf="${esc(csrfToken)}">
      ${icon('whatsapp')}<span data-button-label>Abrir no WhatsApp</span>
    </a>
    <button class="copy-phone" type="button" data-copy-phone="${esc(phone.phoneNormalized)}">
      Copiar telefone
    </button>
    <p class="action-status" role="status" aria-live="polite" aria-atomic="true" data-whatsapp-status></p>
  </div>`;
}

function formatArrival(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '—', time: '' };
  return {
    date: date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    time: date.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }),
  };
}

function sourceLabel(source) {
  const labels = {
    MANUAL: 'Cadastro manual',
    META_INSTANT_FORM: 'Formulário da Meta',
  };
  return labels[source] || source || '—';
}

function metadataValue(value) {
  return esc(value || '—');
}

function dashboardFilterQuery(filters, overrides = {}) {
  const source = { ...filters, ...overrides };
  const params = new URLSearchParams();
  for (const key of [
    'search', 'course', 'city', 'stage', 'commercial', 'lostReason', 'instanceId', 'labelId',
    'metaConnectionId', 'businessId', 'pageId', 'formId', 'campaignId',
    'adsetId', 'adId', 'attributed', 'validPhone', 'unattended',
    'dateFrom', 'dateTo', 'sort', 'page',
  ]) {
    if (source[key] != null && String(source[key]) !== '') {
      params.set(key, String(source[key]));
    }
  }
  return params.toString();
}

const ADVANCED_FILTER_KEYS = Object.freeze([
    'course', 'city', 'stage', 'commercial', 'lostReason', 'instanceId', 'labelId',
  'metaConnectionId', 'businessId', 'pageId', 'formId', 'campaignId',
  'adsetId', 'adId', 'attributed', 'validPhone', 'unattended',
  'dateFrom', 'dateTo', 'sort',
]);

function activeDashboardFilters(filters) {
  const labels = {
    search: 'Busca', course: 'Curso', city: 'Cidade', stage: 'Etapa', commercial: 'Filtro comercial',
    lostReason: 'Motivo', instanceId: 'Instância WA2', labelId: 'Etiqueta WA2',
    metaConnectionId: 'Conexão Meta', businessId: 'BM', pageId: 'Página',
    formId: 'Formulário', campaignId: 'Campanha', adsetId: 'Conjunto',
    adId: 'Anúncio', attributed: 'Atribuição', validPhone: 'Telefone',
    unattended: 'Atendimento', dateFrom: 'Desde', dateTo: 'Até', sort: 'Ordenação',
  };
  return ['search', ...ADVANCED_FILTER_KEYS]
    .filter((key) => {
      const value = String(filters[key] || '');
      return value && !(key === 'sort' && value === 'recent');
    })
    .map((key) => ({ key, label: labels[key], value: String(filters[key]) }));
}

function hiddenFilterFields(filters, excluded = []) {
  const excludedSet = new Set(excluded);
  return ['search', ...ADVANCED_FILTER_KEYS]
    .filter((key) => !excludedSet.has(key) && filters[key] != null && String(filters[key]) !== '')
    .map((key) => `<input type="hidden" name="${key}" value="${esc(filters[key])}">`)
    .join('');
}

function stageActions(lead, csrfToken, returnPath = '/') {
  const actions = getStageActions(lead.stage).filter(
    ({ stage }) => !['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(stage),
  );
  if (actions.length === 0) {
    return `<button type="button" class="action-button action-secondary" disabled>
      ${icon('stage')}<span>Sem transição disponível</span>
    </button>`;
  }
  return `<div class="inline-stage-actions" aria-label="Ações de etapa">
      ${actions.map(({ stage, label }) => `
      <form method="post" action="/leads/${esc(lead.id)}/stage">
      ${csrfField(csrfToken)}
      <input type="hidden" name="returnTo" value="${esc(returnPath)}">
      <input type="hidden" name="stage" value="${stage}">
      <button class="action-button action-secondary">${esc(label)}</button>
      </form>`).join('')}
    </div>`;
}

function moreLeadActions(lead) {
  return `<details class="action-disclosure" data-action-disclosure>
    <summary class="action-button action-secondary">
      ${icon('more')}<span>Mais ações</span>${icon('chevron')}
    </summary>
    <div class="action-menu">
      <a class="action-menu-item" href="/leads/${esc(lead.id)}">
        ${icon('details')}<span>Ver detalhes e histórico</span>
      </a>
      <a class="action-menu-item" href="/leads/${esc(lead.id)}/wa2">
        ${icon('wa2')}<span>WA2 e etiquetas</span>
      </a>
    </div>
  </details>`;
}

function leadOriginDetails(lead) {
  return `<details class="origin-details">
    <summary>Detalhes da origem</summary>
    <dl>
      <div><dt>ID Meta</dt><dd>${metadataValue(lead.meta_lead_id)}</dd></div>
      <div><dt>Conexão</dt><dd>${metadataValue(lead.meta_connection_name)}</dd></div>
      <div><dt>BM</dt><dd>${metadataValue(lead.meta_business_id || lead.business_id)}</dd></div>
      <div><dt>Página</dt><dd>${metadataValue(lead.meta_page_name || lead.meta_page_id)}</dd></div>
      <div><dt>Formulário</dt><dd>${metadataValue(lead.meta_form_name || lead.meta_form_id)}</dd></div>
      <div><dt>Campanha</dt><dd>${metadataValue(lead.meta_campaign_id)}</dd></div>
      <div><dt>Conjunto</dt><dd>${metadataValue(lead.meta_adset_id)}</dd></div>
      <div><dt>Anúncio</dt><dd>${metadataValue(lead.meta_ad_id)}</dd></div>
      <div><dt>WA2</dt><dd>${metadataValue(lead.wa2_instance_name)}</dd></div>
    </dl>
  </details>`;
}

function leadActions(lead, csrfToken, returnPath = '/', whatsappMessage = '') {
  return `<div class="lead-actions" data-lead-actions>
    <div class="whatsapp-action">${whatsappAction(lead, csrfToken, whatsappMessage)}</div>
    <div class="lead-secondary-actions">
      ${stageActions(lead, csrfToken, returnPath)}
      <button type="button" class="action-button action-danger" data-lost-lead="${esc(lead.id)}">Perder</button>
      ${moreLeadActions(lead)}
    </div>
  </div>`;
}

export function renderLeadRow(lead, { csrfToken = '', returnPath = '/', whatsappMessage = '' } = {}) {
  const arrival = formatArrival(lead.received_at || lead.created_at);
  return `<tr data-lead-id="${esc(lead.id)}">
    <td data-label="Selecionar"><input class="lead-select" form="bulk-leads" type="checkbox" name="leadIds" value="${esc(lead.id)}" aria-label="Selecionar ${esc(lead.name)}"></td>
    <td data-label="Lead"><strong><a href="/leads/${esc(lead.id)}">${esc(lead.name)}</a></strong><small>${esc(lead.phone || 'Sem telefone')}${lead.email ? `<br>${esc(lead.email)}` : ''}</small></td>
    <td data-label="Curso e cidade"><strong>${esc(lead.course || 'Curso não informado')}</strong><small>${esc(lead.city || 'Cidade não informada')}</small></td>
    <td data-label="Origem e chegada"><strong>${esc(sourceLabel(lead.source))}</strong><small>${esc(arrival.date)}${arrival.time ? ` · ${esc(arrival.time)}` : ''}</small>${leadOriginDetails(lead)}</td>
    <td data-label="Etapa"><span class="badge ${esc(getStageBadgeClass(lead.stage))}">${esc(STAGE_LABELS[lead.stage] || lead.stage)}</span>${lead.lost_reason ? `<small>Motivo: ${esc(LOST_REASON_LABELS[lead.lost_reason] || lead.lost_reason)}</small>` : ''}</td>
    <td data-label="Etiquetas"><div class="wa2-tags">${wa2Labels(lead, { compact: true })}</div>${metaStatusMarkup(lead)}</td>
    <td data-label="Ações" class="actions-cell">${leadActions(lead, csrfToken, returnPath, whatsappMessage)}</td>
  </tr>`;
}

export function renderLeadCard(lead, { csrfToken = '', returnPath = '/', whatsappMessage = '' } = {}) {
  const arrival = formatArrival(lead.received_at || lead.created_at);
  return `<article class="lead-card" data-lead-id="${esc(lead.id)}" aria-labelledby="lead-card-${esc(lead.id)}">
    <div class="lead-card-heading"><div><input class="lead-select" form="bulk-leads" type="checkbox" name="leadIds" value="${esc(lead.id)}" aria-label="Selecionar ${esc(lead.name)}"><h3 id="lead-card-${esc(lead.id)}"><a href="/leads/${esc(lead.id)}">${esc(lead.name)}</a></h3></div><span class="badge ${esc(getStageBadgeClass(lead.stage))}">${esc(STAGE_LABELS[lead.stage] || lead.stage)}</span></div>
    <dl class="lead-card-summary"><div><dt>Curso</dt><dd>${esc(lead.course || 'Não informado')}</dd></div><div><dt>Cidade</dt><dd>${esc(lead.city || 'Não informada')}</dd></div><div><dt>Origem e chegada</dt><dd>${esc(sourceLabel(lead.source))} · ${esc(arrival.date)}${arrival.time ? ` às ${esc(arrival.time)}` : ''}</dd></div><div><dt>Telefone</dt><dd>${esc(lead.phone || 'Sem telefone')}</dd></div></dl>
    <div class="wa2-tags">${wa2Labels(lead, { compact: true })}</div>${metaStatusMarkup(lead)}${leadOriginDetails(lead)}${leadActions(lead, csrfToken, returnPath, whatsappMessage)}
  </article>`;
}

export function dashboardView({
  leads,
  counts,
  metaStatus,
  message = '',
  error = '',
  operationStartAt = null,
  filters = {},
  pagination = { page: 1, hasNext: false },
  wa2Instances = [],
  metaConnections = [],
  whatsappMessage = '',
  csrfToken = '',
}) {
  const returnPath = `/?${dashboardFilterQuery(filters)}`;
  const rows = leads.map((lead) => renderLeadRow(lead, { csrfToken, returnPath, whatsappMessage })).join('');
  const cards = leads.map((lead) => renderLeadCard(lead, { csrfToken, returnPath, whatsappMessage })).join('');
  const appliedFilters = activeDashboardFilters(filters);

  return layout('Leads', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}

    <section class="hero">
      <div><h1>Leads e conversões</h1><p>Atendimento comercial, WhatsApp, WA2 e atribuição Meta por origem.</p></div>
      <div class="meta-box ${metaStatus.configured ? 'ready' : 'pending'}">
        <strong>${metaStatus.configured ? 'Meta configurada' : 'Meta pendente'}</strong>
        <span>Graph ${esc(metaStatus.graphVersion)} · ${metaStatus.testMode ? 'MODO TESTE' : 'PRODUÇÃO'}</span>
        ${metaStatus.missing.length ? `<small>Faltando: ${esc(metaStatus.missing.join(', '))}</small>` : ''}
      </div>
    </section>

    <section class="panel filter-workspace" aria-labelledby="filter-title">
      <div class="panel-title"><div><h2 id="filter-title">Encontrar leads</h2>
        <small>Consultas paginadas e isoladas por tenant.</small></div>
        <button type="button" class="secondary" data-filter-open aria-haspopup="dialog"
          aria-controls="advanced-filters">Filtros avançados
          ${appliedFilters.length ? `<span class="filter-count" aria-label="${esc(appliedFilters.length)} filtros ativos">${esc(appliedFilters.length)}</span>` : ''}
        </button>
      </div>
      <form method="get" action="/" class="quick-search" role="search">
        ${hiddenFilterFields(filters, ['search', 'page'])}
        <label for="lead-search">Busca rápida</label>
        <div><input id="lead-search" name="search" value="${esc(filters.search || '')}"
          placeholder="Nome, telefone, e-mail ou curso">
          <button type="submit">Buscar</button></div>
      </form>
      ${appliedFilters.length ? `<div class="filter-summary" aria-label="Filtros aplicados">
        <strong>Filtros aplicados:</strong>
        <ul>${appliedFilters.map((item) => `<li>${esc(item.label)}: ${esc(item.value)}</li>`).join('')}</ul>
        <a href="/">Limpar filtros</a>
      </div>` : '<p class="muted filter-empty">Nenhum filtro aplicado.</p>'}
    </section>

    <dialog id="advanced-filters" class="filter-drawer" aria-labelledby="advanced-filter-title">
      <form method="get" action="/" class="filter-dialog-form">
        <div class="filter-drawer-header"><div><h2 id="advanced-filter-title">Filtros avançados</h2>
          <p>Refine a lista sem perder a busca rápida.</p></div>
          <button type="button" class="secondary icon-only" data-filter-close aria-label="Fechar filtros">${icon('x')}</button>
        </div>
        <div class="filter-grid">
        <input type="hidden" name="search" value="${esc(filters.search || '')}">
        <label>Curso/interesse<input name="course" value="${esc(filters.course || '')}"></label>
        <label>Cidade<input name="city" value="${esc(filters.city || '')}"></label>
        <label>Etapa<select name="stage"><option value="">Todas</option>${Object.entries(STAGE_LABELS).map(([value, label]) => `<option value="${value}"${filters.stage === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Filtro comercial<select name="commercial"><option value="">Todos</option><option value="mql"${filters.commercial === 'mql' ? ' selected' : ''}>Qualificados — CRM 02 a CRM 04</option></select></label>
        <label>Motivo da perda<select name="lostReason"><option value="">Todos</option>${Object.entries(LOST_REASON_LABELS).map(([value, label]) => `<option value="${value}"${filters.lostReason === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Instância WA2<select name="instanceId"><option value="">Todas</option>${wa2Instances.map((instance) => `<option value="${esc(instance.id)}"${filters.instanceId === instance.id ? ' selected' : ''}>${detailValue(instance.name || instance.remote_instance_id)}</option>`).join('')}</select></label>
        <label>Etiqueta WA2 (ID ou nome)<input name="labelId" value="${esc(filters.labelId || '')}"></label>
        <label>Conexão Meta<select name="metaConnectionId"><option value="">Todas</option>${metaConnections.map((connection) => `<option value="${esc(connection.id)}"${filters.metaConnectionId === connection.id ? ' selected' : ''}>${esc(connection.name)}</option>`).join('')}</select></label>
        <label>BM<input name="businessId" value="${esc(filters.businessId || '')}" inputmode="numeric"></label>
        <label>Página<input name="pageId" value="${esc(filters.pageId || '')}"></label>
        <label>Formulário<input name="formId" value="${esc(filters.formId || '')}"></label>
        <label>Campanha<input name="campaignId" value="${esc(filters.campaignId || '')}"></label>
        <label>Conjunto<input name="adsetId" value="${esc(filters.adsetId || '')}"></label>
        <label>Anúncio<input name="adId" value="${esc(filters.adId || '')}"></label>
        <label>Atribuição Meta<select name="attributed"><option value="">Todas</option><option value="yes"${filters.attributed === 'yes' ? ' selected' : ''}>Atribuído</option><option value="no"${filters.attributed === 'no' ? ' selected' : ''}>Não atribuído</option></select></label>
        <label>Telefone<select name="validPhone"><option value="">Todos</option><option value="yes"${filters.validPhone === 'yes' ? ' selected' : ''}>Válido</option><option value="no"${filters.validPhone === 'no' ? ' selected' : ''}>Inválido/ausente</option></select></label>
        <label>Atendimento<select name="unattended"><option value="">Todos</option><option value="yes"${filters.unattended === 'yes' ? ' selected' : ''}>Sem atendimento</option></select></label>
        <label>Entrada desde<input type="date" name="dateFrom" value="${esc(filters.dateFrom || '')}"></label>
        <label>Entrada até<input type="date" name="dateTo" value="${esc(filters.dateTo || '')}"></label>
        <label>Ordenar<select name="sort">${[['recent','Mais recentes'],['oldest','Mais antigos'],['stage','Etapa'],['unattended','Sem atendimento'],['updated','Última atualização'],['conversation','Última conversa']].map(([value, label]) => `<option value="${value}"${filters.sort === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        </div>
        <div class="filter-drawer-actions"><a class="button-link secondary" href="/">Limpar</a>
          <button type="submit">Aplicar filtros</button></div>
      </form>
    </dialog>

    <section class="stats priority-stats" aria-label="Prioridades comerciais">
      ${stat('Sem atendimento', counts.unattended || 0, 'priority')}
      ${stat('Leads novos', counts.new, 'priority')}
      ${stat('Sem resposta', counts.no_response || 0, 'priority')}
      ${stat('Oportunidades', counts.opportunities, 'priority')}
      ${stat('Aguardando matrícula', counts.awaiting_enrollment || 0, 'priority')}
      ${stat('Aguardando pagamento', counts.awaiting_payment || 0, 'priority')}
      ${stat('Falhas de integração', counts.metaFailed, counts.metaFailed ? 'risk' : '')}
      ${stat('Total', counts.total)}${stat('Em atendimento', counts.in_service)}
      ${stat('Qualificados', counts.qualified)}${stat('Matriculados', counts.enrolled)}
      ${stat('Pagos', counts.paid)}${stat('Perdidos', counts.lost)}
      ${stat('Taxa de qualificação', `${counts.qualificationRate}%`)}
      ${stat('Taxa de matrícula', `${counts.matriculationRate}%`)}
    </section>

    <details class="panel dashboard-tool" id="whatsapp-settings">
      <summary>Mensagem inicial do WhatsApp</summary>
      <p class="muted">Configuração isolada deste tenant. Use {{nome}} para personalizar.</p>
      <form method="post" action="/settings/whatsapp-message" class="compact-form stack">
        ${csrfField(csrfToken)}
        <textarea name="message" required maxlength="1000">${esc(whatsappMessage)}</textarea>
        <button>Salvar mensagem</button>
      </form>
    </details>

    <section class="panel">
      <div class="panel-title">
        <div>
          <h2>Fila de leads</h2>
          ${operationStartAt ? `<small>Operação iniciada em ${formatDateTime(operationStartAt)}. Leads anteriores permanecem armazenados.</small>` : ''}
        </div>
        <span>${leads.length} exibidos</span>
      </div>
      <form id="bulk-leads" method="post" action="/leads/bulk" class="bulk-toolbar" data-confirm="Aplicar esta ação a todos os leads selecionados?">
        ${csrfField(csrfToken)}
        <input type="hidden" name="returnTo" value="${esc(returnPath)}">
        <strong>Ações em lote</strong>
        <select name="bulkAction" required><option value="stage">Alterar etapa</option><option value="sync">Sincronizar etiqueta WA2</option></select>
        <select name="stage"><option value="">Selecione a etapa...</option>${Object.entries(STAGE_LABELS).filter(([stage]) => !['ENROLLED','PAID'].includes(stage)).map(([stage, label]) => `<option value="${stage}">${esc(label)}</option>`).join('')}</select>
        <select name="lostReason"><option value="">Motivo da perda...</option>${Object.entries(LOST_REASON_LABELS).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select>
        <input name="lostNotes" maxlength="1000" placeholder="Observação quando Outro">
        <button>Aplicar aos selecionados</button>
        <a class="button-link secondary" href="/leads/export.csv?${esc(dashboardFilterQuery(filters))}">Exportar CSV</a>
      </form>
      <div class="lead-cards" aria-label="Leads em cards">
        ${cards || '<div class="empty">Nenhum lead encontrado.</div>'}
      </div>
      <div class="table-wrap desktop-leads"><table class="leads-table">
        <thead><tr><th><span class="sr-only">Selecionar</span></th><th>Lead</th>
          <th>Curso e cidade</th><th>Origem e chegada</th><th>Etapa</th><th>Etiquetas / Meta</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">Nenhum lead encontrado.</td></tr>'}</tbody>
      </table></div>
      <nav class="pagination" aria-label="Paginação de leads">
        ${pagination.page > 1 ? `<a class="button-link secondary" href="/?${esc(dashboardFilterQuery(filters, { page: pagination.page - 1 }))}">← Anterior</a>` : ''}
        <span>Página ${esc(pagination.page)}</span>
        ${pagination.hasNext ? `<a class="button-link secondary" href="/?${esc(dashboardFilterQuery(filters, { page: pagination.page + 1 }))}">Próxima →</a>` : ''}
      </nav>
    </section>
    <dialog id="lost-dialog" class="modal" aria-labelledby="lost-dialog-title" aria-describedby="lost-dialog-description">
      <form method="post" id="lost-form">
        ${csrfField(csrfToken)}
        <input type="hidden" name="returnTo" value="${esc(returnPath)}">
        <h2 id="lost-dialog-title">Encerrar lead</h2>
        <p id="lost-dialog-description">Escolha o motivo. Nenhum evento positivo será enviado à Meta.</p>
        <label>Motivo<select name="lostReason" required><option value="">Selecione</option>${Object.entries(LOST_REASON_LABELS).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select></label>
        <label class="lost-notes">Observação<textarea name="lostNotes" maxlength="1000"></textarea></label>
        <div class="actions"><button class="danger">Confirmar encerramento</button><button type="button" class="secondary" data-close-dialog>Cancelar</button></div>
      </form>
    </dialog>
  `, { csrfToken });
}

export function leadDetailView({
  lead,
  history = [],
  csrfToken = '',
}) {
  const activityLabels = {
    LEAD_RECEIVED: 'Lead recebido',
    HISTORICAL_IMPORT: 'Importado historicamente',
    WHATSAPP_OPENED: 'WhatsApp aberto',
    STAGE_CHANGED: 'Etapa alterada',
    LABEL_SYNC_REQUESTED: 'Sincronização de etiqueta solicitada',
    LABEL_APPLIED: 'Etiqueta aplicada',
    LABEL_REMOVED: 'Etiqueta removida',
    META_EVENT_QUEUED: 'Evento Meta enfileirado',
    META_EVENT_SENT: 'Evento Meta enviado',
    META_EVENT_FAILED: 'Erro no evento Meta',
    SYNC_CONFLICT: 'Conflito de sincronização',
    LOST: 'Lead perdido',
  };
  const timeline = history.map((item) => `
    <li>
      <strong>${esc(activityLabels[item.activity_type] || 'Atividade')}</strong>
      <small>${formatDateTime(item.changed_at)} · ${esc(item.origin || '—')} · ${esc(item.changed_by || 'Sistema')}</small>
      ${item.previous_stage !== item.new_stage ? `<div>${esc(STAGE_LABELS[item.previous_stage] || item.previous_stage)} → <strong>${esc(STAGE_LABELS[item.new_stage] || item.new_stage)}</strong></div>` : ''}
      ${item.reason ? `<div>Motivo: ${esc(LOST_REASON_LABELS[item.reason] || item.reason)}</div>` : ''}
      ${item.observation ? `<div>${esc(item.observation)}</div>` : ''}
      ${item.meta_event_id ? `<small>Evento Meta: ${esc(item.meta_event_id)}</small>` : ''}
    </li>`).join('');
  return layout(`Lead ${lead.name}`, `
    <section class="hero">
      <div><h1>${esc(lead.name)}</h1><p>Detalhes administrativos e histórico auditável.</p></div>
      <span class="badge ${esc(getStageBadgeClass(lead.stage))}">${esc(STAGE_LABELS[lead.stage] || lead.stage)}</span>
    </section>
    <section class="panel detail-grid">
      <div><strong>Telefone recebido</strong><span>${detailValue(lead.phone)}</span></div>
      <div><strong>Telefone normalizado</strong><span>${detailValue(lead.phone_normalized)}</span></div>
      <div><strong>E-mail</strong><span>${detailValue(lead.email)}</span></div>
      <div><strong>Curso/interesse</strong><span>${detailValue(lead.course)}</span></div>
      <div><strong>Cidade</strong><span>${detailValue(lead.city)}</span></div>
      <div><strong>Meta Lead ID</strong><span>${detailValue(lead.meta_lead_id)}</span></div>
      <div><strong>Página</strong><span>${detailValue(lead.meta_page_id)}</span></div>
      <div><strong>Formulário</strong><span>${detailValue(lead.meta_form_id)}</span></div>
      <div><strong>Campanha</strong><span>${detailValue(lead.meta_campaign_id)}</span></div>
      <div><strong>Conjunto</strong><span>${detailValue(lead.meta_adset_id)}</span></div>
      <div><strong>Anúncio</strong><span>${detailValue(lead.meta_ad_id)}</span></div>
      <div><strong>Dataset</strong><span>${detailValue(lead.dataset_id)}</span></div>
      <div><strong>Motivo da perda</strong><span>${detailValue(LOST_REASON_LABELS[lead.lost_reason] || lead.lost_reason)}</span></div>
      <div><strong>Observação da perda</strong><span>${detailValue(lead.lost_notes)}</span></div>
      <div><strong>Instância WhatsApp</strong><span>${detailValue(lead.wa2_instance_name)}</span></div>
      <div><strong>Última sincronização WA2</strong><span>${detailValue(lead.wa2_labels_synced_at ? formatDateTime(lead.wa2_labels_synced_at) : null)}</span></div>
    </section>
    <section class="panel"><div class="panel-title"><h2>Etiquetas WhatsApp</h2><div class="wa2-tags">${wa2Labels(lead)}</div></div>${metaStatusMarkup(lead)}</section>
    <section class="panel">
      <div class="panel-title"><h2>Linha do tempo</h2><span>${history.length} evento(s)</span></div>
      <ol class="timeline">${timeline || '<li>Nenhuma atividade registrada.</li>'}</ol>
    </section>
    <a class="button-link secondary" href="/">Voltar aos leads</a>
  `, { csrfToken });
}

export function metaConnectionsView({
  connections = [],
  selected = null,
  remotePages = [],
  remoteForms = [],
  selectedPageId = '',
  message = '',
  error = '',
  csrfToken = '',
}) {
  const rows = connections.map((connection) => `
    <tr>
      <td><strong>${esc(connection.name)}</strong><small>BM ${esc(connection.business_id)}</small></td>
      <td><span class="badge ${connection.status === 'VALID' ? 'paid' : connection.status === 'ERROR' ? 'lost' : 'new'}">${esc({
        PENDING: 'Pendente', VALID: 'Válida', INVALID: 'Inválida', ERROR: 'Erro',
      }[connection.status] || connection.status)}</span><small>${connection.active ? 'Ativa' : 'Inativa'}</small></td>
      <td>${esc(connection.page_count)} página(s)<small>${esc(connection.form_count)} formulário(s) · ${esc(connection.dataset_count)} dataset(s)</small></td>
      <td>${connection.last_error ? `<small class="error-text">${esc(connection.last_error)}</small>` : '—'}</td>
      <td><div class="actions"><a class="action-button stage-secondary" href="/meta/connections?connectionId=${esc(connection.id)}">Configurar</a>
        <form method="post" action="/meta/connections/${esc(connection.id)}/active"${connection.active ? ' data-confirm="Desativar esta conexão Meta? O histórico será preservado."' : ''}>${csrfField(csrfToken)}<input type="hidden" name="active" value="${connection.active ? 'false' : 'true'}">${connection.active ? '<input type="hidden" name="confirmation" value="DEACTIVATE_META_CONNECTION">' : ''}<button class="action-button ${connection.active ? 'danger' : 'success'}">${connection.active ? 'Desativar' : 'Ativar'}</button></form>
      </div></td>
    </tr>`).join('');
  const pageOptions = remotePages.map((page) => `<option value="${esc(page.id)}">${esc(page.name)} · ${esc(page.id)}</option>`).join('');
  const savedPageOptions = (selected?.pages || []).map((page) => `<option value="${esc(page.id)}">${esc(page.name)} · ${esc(page.page_id)}</option>`).join('');
  const formOptions = remoteForms.map((form) => `<option value="${esc(form.id)}">${esc(form.name)} · ${esc(form.id)}</option>`).join('');
  return layout('Conexões Meta', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero"><div><h1>Conexões Meta</h1><p>Múltiplos BMs, páginas, formulários e datasets, sempre isolados por tenant.</p></div></section>
    <section class="panel">
      <h2>Adicionar conexão</h2>
      <form method="post" action="/meta/connections" class="filter-grid">
        ${csrfField(csrfToken)}
        <label>Nome<input name="name" required maxlength="200"></label>
        <label>Business ID<input name="businessId" required inputmode="numeric"></label>
        <label>Ad Account ID<input name="adAccountId" inputmode="numeric"></label>
        <label>App ID<input name="appId" inputmode="numeric"></label>
        <label>Access token<input name="accessToken" type="password" required autocomplete="new-password"></label>
        <label>App Secret opcional<input name="appSecret" type="password" autocomplete="new-password"></label>
        <button>Validar e salvar</button>
      </form>
      <small>Credenciais são criptografadas no servidor e nunca retornam ao navegador.</small>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Conexões cadastradas</h2><span>${connections.length}</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${connections.map((connection) => `<article class="admin-card">
          <header><div><span class="eyebrow">Conexão Meta</span><h3>${esc(connection.name)}</h3></div>
            ${operationStatus(connection.status)}</header>
          <dl><div><dt>Estado</dt><dd>${connection.active ? 'Ativa' : 'Inativa'}</dd></div>
            <div><dt>Recursos</dt><dd>${esc(connection.page_count)} página(s) · ${esc(connection.form_count)} formulário(s) · ${esc(connection.dataset_count)} dataset(s)</dd></div></dl>
          ${connection.last_error ? `<div class="alert error">${esc(connection.last_error)}</div>` : ''}
          <div class="actions"><a class="button-link secondary" href="/meta/connections?connectionId=${esc(connection.id)}">Configurar</a>
            <form method="post" action="/meta/connections/${esc(connection.id)}/active"${connection.active ? ' data-confirm="Desativar esta conexão Meta? O histórico será preservado."' : ''}>
              ${csrfField(csrfToken)}<input type="hidden" name="active" value="${connection.active ? 'false' : 'true'}">
              ${connection.active ? '<input type="hidden" name="confirmation" value="DEACTIVATE_META_CONNECTION">' : ''}
              <button class="${connection.active ? 'danger' : 'success'}">${connection.active ? 'Desativar' : 'Ativar'}</button></form></div>
          <details class="technical-details"><summary>Identificadores</summary><p>Business Manager: ${esc(connection.business_id)}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhuma conexão cadastrada</h3><p>Adicione uma conexão para validar páginas e formulários.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table><thead><tr><th>Conexão/BM</th><th>Status</th><th>Recursos</th><th>Último erro</th><th>Ações</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">Nenhuma conexão cadastrada.</td></tr>'}</tbody></table></div>
    </section>
    ${selected ? `
      <section class="panel">
        <div class="panel-title"><div><h2>${esc(selected.name)}</h2><small>Token: •••••••• · segredo nunca exibido</small></div><a class="button-link secondary" href="/meta/connections?connectionId=${esc(selected.id)}&discover=pages">Listar páginas acessíveis</a></div>
        <form method="post" action="/meta/connections/${esc(selected.id)}/name" class="compact-form stack">${csrfField(csrfToken)}<label>Nome da conexão<input name="name" value="${esc(selected.name)}" required maxlength="200"></label><button>Atualizar nome</button></form>
        ${remotePages.length ? `<form method="post" action="/meta/connections/${esc(selected.id)}/pages" class="compact-form stack">${csrfField(csrfToken)}<label>Página acessível<select name="pageId" required><option value="">Selecione</option>${pageOptions}</select></label><button>Adicionar página</button></form>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Página</th><th>ID</th><th>Estado</th><th>Formulários</th></tr></thead><tbody>${selected.pages.map((page) => `<tr><td>${esc(page.name)}</td><td>${esc(page.page_id)}</td><td>${page.active ? 'Ativa' : 'Inativa'}</td><td><a href="/meta/connections?connectionId=${esc(selected.id)}&discover=forms&pageId=${esc(page.page_id)}">Listar formulários</a></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nenhuma página selecionada.</td></tr>'}</tbody></table></div>
      </section>
      ${remoteForms.length ? `<section class="panel"><h2>Formulários da página ${esc(selectedPageId)}</h2><form method="post" action="/meta/connections/${esc(selected.id)}/forms" class="compact-form stack">${csrfField(csrfToken)}<input type="hidden" name="pageId" value="${esc(selectedPageId)}"><label>Página salva<select name="pageRecordId" required>${savedPageOptions}</select></label><label>Formulário<select name="formId" required><option value="">Selecione</option>${formOptions}</select></label><button>Adicionar formulário</button></form></section>` : ''}
      <section class="panel"><h2>Dataset/pixel</h2><form method="post" action="/meta/connections/${esc(selected.id)}/datasets" class="filter-grid">${csrfField(csrfToken)}<label>Nome<input name="name" required maxlength="200"></label><label>Dataset ID<input name="datasetId" required inputmode="numeric"></label><label>Test Event Code opcional<input name="testEventCode" type="password"></label><button>Salvar dataset</button></form>
        <div class="table-wrap"><table><thead><tr><th>Dataset</th><th>ID</th><th>Estado</th><th>Última validação</th><th>Erro/ação</th></tr></thead><tbody>${selected.datasets.map((dataset) => `<tr><td>${esc(dataset.name)}</td><td>${esc(dataset.dataset_id)}</td><td>${dataset.active ? 'Ativo' : 'Inativo'}</td><td>${formatDateTime(dataset.last_test_at)}</td><td>${detailValue(dataset.last_error)}${dataset.active ? `<form method="post" action="/meta/connections/${esc(selected.id)}/datasets/${esc(dataset.id)}/validate">${csrfField(csrfToken)}<button class="small">Validar dataset</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum dataset configurado.</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel"><h2>Renovar token</h2><form method="post" action="/meta/connections/${esc(selected.id)}/token" class="compact-form stack">${csrfField(csrfToken)}<label>Novo access token<input name="accessToken" type="password" required autocomplete="new-password"></label><button>Validar e substituir</button></form></section>
    ` : ''}
  `, { csrfToken });
}

function statusClass(status) {
  if (['SENT', 'COMPLETED', 'DONE', 'VALID', 'CONNECTED'].includes(status)) return 'paid';
  if (['FAILED', 'ERROR', 'INVALID', 'CANCELLED', 'DISCONNECTED'].includes(status)) return 'lost';
  if (status === 'RETRY') return 'contact-started';
  if (['PROCESSING', 'RUNNING', 'PARTIAL', 'CONNECTING', 'QR_REQUIRED'].includes(status)) return 'opportunity';
  return 'new';
}

export function eventsView({ events, jobs, message = '', error = '', csrfToken = '' }) {
  const statusLabels = {
    PENDING: 'Pendente',
    PROCESSING: 'Processando',
    RUNNING: 'Processando',
    RETRY: 'Nova tentativa',
    SENT: 'Enviado',
    COMPLETED: 'Concluído',
    DONE: 'Concluído',
    FAILED: 'Falhou',
    CANCELLED: 'Cancelado',
  };
  const rows = events.map((event) => `
    <tr>
      <td><strong>${esc(event.event_name)}</strong><small>${event.event_id.endsWith(':test') ? 'TESTE' : 'PRODUÇÃO'} · ${esc(event.event_id)}</small></td>
      <td>${esc(event.lead_name)}<small>${esc(event.meta_lead_id || 'sem lead_id')}</small></td>
      <td><span class="badge ${statusClass(event.status)}">${esc(statusLabels[event.status] || event.status)}</span><small>${esc(event.attempts)} tentativa(s)</small></td>
      <td>${formatDateTime(event.sent_at)}${event.last_error ? `<small class="error-text">${esc(event.last_error)}</small>` : ''}</td>
    </tr>`).join('');

  const jobRows = jobs.map((job) => `
    <tr>
      <td>
        <strong>${job.job_type === 'LEAD_IMPORT' ? 'Importação de lead' : esc(job.event_name || 'Conversão')}</strong>
        <small>${job.event_id ? `${job.event_id.endsWith(':test') ? 'TESTE' : 'PRODUÇÃO'} · ` : ''}${esc(job.meta_lead_id || job.id)}</small>
      </td>
      <td>${esc(job.lead_name || '—')}<small>${formatDateTime(job.created_at)}</small></td>
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span>
        <small>${esc(job.attempts)} tentativa(s)${job.status === 'RETRY' ? `<br>Próxima: ${formatDateTime(job.next_attempt_at)}` : ''}</small>
      </td>
      <td>
        ${job.last_error ? `<small class="error-text">${esc(job.last_error)}</small>` : '—'}
        ${job.status === 'FAILED' ? `
          <form method="post" action="/jobs/${esc(job.id)}/retry" class="retry-form"
            data-confirm="Enfileirar novamente este job Meta?">
            ${csrfField(csrfToken)}
            <button type="submit" class="small">Enfileirar novamente</button>
          </form>` : ''}
      </td>
    </tr>`).join('');

  return layout('Eventos Meta', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero"><div><h1>Eventos e fila Meta</h1><p>Conversões e importações são processadas de forma assíncrona pelo worker.</p></div></section>
    <section class="panel">
      <div class="panel-title"><h2>Fila persistente</h2><span>${jobs.length} exibidos</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${jobs.map((job) => `<article class="admin-card">
          <header><div><span class="eyebrow">Job Meta</span><h3>${job.job_type === 'LEAD_IMPORT' ? 'Importação de lead' : esc(job.event_name || 'Conversão')}</h3></div>
            <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span></header>
          <dl><div><dt>Lead</dt><dd>${esc(job.lead_name || '—')}</dd></div>
            <div><dt>Criado</dt><dd>${formatDateTime(job.created_at)}</dd></div>
            <div><dt>Tentativas</dt><dd>${esc(job.attempts)}</dd></div>
            ${job.status === 'RETRY' ? `<div><dt>Próxima tentativa</dt><dd>${formatDateTime(job.next_attempt_at)}</dd></div>` : ''}
          </dl>
          ${job.last_error ? `<div class="alert error">${esc(job.last_error)}</div>` : ''}
          ${job.status === 'FAILED' ? `<form method="post" action="/jobs/${esc(job.id)}/retry"
            data-confirm="Enfileirar novamente este job Meta?">${csrfField(csrfToken)}
            <button>Enfileirar novamente</button></form>` : ''}
          <details class="technical-details"><summary>Identificadores</summary><p>${esc(job.meta_lead_id || job.id)}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhum job registrado</h3><p>A fila aparecerá aqui quando uma operação for solicitada.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table>
        <thead><tr><th>Job</th><th>Lead/criação</th><th>Status</th><th>Erro/ação</th></tr></thead>
        <tbody>${jobRows || '<tr><td colspan="4" class="empty">Nenhum job registrado.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section class="panel"><div class="panel-title"><h2>Eventos enviados</h2><span>${events.length} exibidos</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${events.map((event) => `<article class="admin-card"><header><div><span class="eyebrow">Evento Meta</span>
          <h3>${esc(event.event_name)}</h3></div><span class="badge ${statusClass(event.status)}">${esc(statusLabels[event.status] || event.status)}</span></header>
          <dl><div><dt>Lead</dt><dd>${esc(event.lead_name)}</dd></div><div><dt>Envio</dt><dd>${formatDateTime(event.sent_at)}</dd></div>
            <div><dt>Tentativas</dt><dd>${esc(event.attempts)}</dd></div></dl>
          ${event.last_error ? `<div class="alert error">${esc(event.last_error)}</div>` : ''}
          <details class="technical-details"><summary>Identificadores</summary><p>${esc(event.event_id)} · ${esc(event.meta_lead_id || 'sem lead_id')}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhum evento enviado</h3><p>As conversões processadas aparecerão aqui.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table>
      <thead><tr><th>Evento</th><th>Lead</th><th>Status</th><th>Envio/erro</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty">Nenhum evento enviado.</td></tr>'}</tbody>
    </table></div></section>
  `, { csrfToken });
}

function wa2StateLabel(status) {
  const labels = {
    configured: 'Configurada',
    disabled: 'Desativada',
    invalid: 'Inválida',
  };
  return labels[status.state] || 'Indisponível';
}

function wa2RemoteStatusLabel(status) {
  return {
    CONNECTED: 'Conectada',
    DISCONNECTED: 'Desconectada',
    CONNECTING: 'Conectando',
    QR_REQUIRED: 'QR necessário',
    ERROR: 'Erro',
  }[String(status || '').toUpperCase()] || status || 'Indisponível';
}

function detailValue(value) {
  return value == null || value === '' ? '—' : esc(value);
}

export function wa2DashboardView({
  configStatus,
  health = null,
  instances = [],
  localInstances = [],
  unavailable = false,
  message = '',
  error = '',
  csrfToken = '',
}) {
  const localByRemoteId = new Map(
    localInstances.map((instance) => [instance.remote_instance_id, instance]),
  );
  const rows = instances.map((instance) => `
    <tr>
      <td><strong>${detailValue(instance.name || instance.id)}</strong><small>${esc(instance.id)}</small></td>
      <td>${detailValue(instance.role)}</td>
      <td>${detailValue(instance.phone)}</td>
      <td><span class="badge ${statusClass(instance.status)}">${esc(wa2RemoteStatusLabel(instance.status))}</span></td>
      <td>${instance.isDefault ? '<span class="ok">Padrão</span>' : '—'}</td>
      <td>
        <a class="small button-link" href="/wa2/instances/${encodeURIComponent(instance.id)}">Detalhes</a>
        ${localByRemoteId.has(instance.id)
          ? '<small class="ok">Salva no CRM</small>'
          : `<form method="post" action="/wa2/instances/import">
              ${csrfField(csrfToken)}
              <input type="hidden" name="remoteInstanceId" value="${esc(instance.id)}">
              <button class="small">Validar e salvar</button>
            </form>`}
      </td>
    </tr>`).join('');
  const localRows = localInstances.map((instance) => `
    <tr>
      <td><strong>${detailValue(instance.name || instance.remote_instance_id)}</strong><small>${esc(instance.remote_instance_id)}</small></td>
      <td>${detailValue(instance.role)}</td>
      <td>${instance.enabled ? '<span class="ok">Habilitada</span>' : '<span class="muted">Desabilitada</span>'}</td>
      <td>${instance.is_default ? '<span class="ok">Padrão</span>' : '—'}</td>
      <td>
        <div class="actions">
          ${!instance.is_default && instance.enabled ? `
            <form method="post" action="/wa2/local-instances/${esc(instance.id)}/default">
              ${csrfField(csrfToken)}
              <button class="small">Definir padrão</button>
            </form>` : ''}
          ${instance.enabled ? `
            <form method="post" action="/wa2/local-instances/${esc(instance.id)}/disable">
              ${csrfField(csrfToken)}
              ${instance.is_default
                ? '<input type="hidden" name="confirmation" value="DISABLE_DEFAULT_WA2_INSTANCE">'
                : ''}
              <button class="small danger">${instance.is_default ? 'Desabilitar e remover padrão' : 'Desabilitar'}</button>
            </form>`
            : `<form method="post" action="/wa2/local-instances/${esc(instance.id)}/enable">
                ${csrfField(csrfToken)}
                <button class="small">Habilitar</button>
              </form>`}
        </div>
      </td>
    </tr>`).join('');

  return layout('WA2', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero">
      <div><h1>WA Sender 2</h1><p>Administração server-side de instâncias e sessão.</p></div>
      <div class="meta-box ${configStatus.state === 'configured' ? 'ready' : 'pending'}">
        <strong>${esc(wa2StateLabel(configStatus))}</strong>
        <span>${health ? `Health: ${esc(health.status || (health.ok ? 'ok' : 'indisponível'))}` : 'Health não consultado'}</span>
        ${unavailable ? '<small>O WA2 não respondeu. Tente novamente mais tarde.</small>' : ''}
        ${configStatus.errors.length ? `<small>${esc(configStatus.errors.join('. '))}</small>` : ''}
      </div>
    </section>
    <section class="panel">
      <h2>Criar instância WhatsApp</h2>
      <form method="post" action="/wa2/instances/create" class="filter-grid">
        ${csrfField(csrfToken)}
        <label>Nome<input name="name" required maxlength="200" placeholder="Ex: UNIVC - 2298"></label>
        <label>Função<select name="role" required>
          <option value="GENERAL">Geral</option>
          <option value="SALES">Vendas</option>
          <option value="SUPPORT">Suporte</option>
          <option value="BILLING">Cobrança</option>
          <option value="POST_SALES">Pós-venda</option>
          <option value="AFFILIATE">Afiliados</option>
        </select></label>
        <button>Criar e gerar QR</button>
      </form>
      <small>A instância real é criada no WA2 e espelhada automaticamente no CRM.</small>
    </section>
    <div class="actions">
      <a class="button-link" href="/wa2/labels">Configurar etiquetas CRM</a>
      <a class="button-link" href="/wa2/label-jobs">Acompanhar jobs de etiquetas</a>
    </div>
    <section class="panel">
      <div class="panel-title"><h2>Instâncias</h2><span>${instances.length} exibidas</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${instances.map((instance) => `<article class="admin-card">
          <header><div><span class="eyebrow">Instância WA2</span><h3>${detailValue(instance.name || instance.id)}</h3></div>
            <span class="badge ${statusClass(instance.status)}">${esc(wa2RemoteStatusLabel(instance.status))}</span></header>
          <dl><div><dt>Telefone</dt><dd>${detailValue(instance.phone)}</dd></div>
            <div><dt>Função</dt><dd>${detailValue(instance.role)}</dd></div>
            <div><dt>Principal</dt><dd>${instance.isDefault ? 'Sim' : 'Não'}</dd></div></dl>
          <div class="actions"><a class="button-link secondary" href="/wa2/instances/${encodeURIComponent(instance.id)}">Ver detalhes</a>
            ${localByRemoteId.has(instance.id) ? '<span class="ok">Salva no CRM</span>' : `<form method="post" action="/wa2/instances/import">
              ${csrfField(csrfToken)}<input type="hidden" name="remoteInstanceId" value="${esc(instance.id)}">
              <button>Validar e salvar</button></form>`}</div>
          <details class="technical-details"><summary>Identificador técnico</summary><p>${esc(instance.id)}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhuma instância disponível</h3><p>Confira a conexão do WA2 e tente novamente.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table>
        <thead><tr><th>Instância</th><th>Função</th><th>Telefone</th><th>Status</th><th>Principal</th><th>Ação</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">Nenhuma instância disponível.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Instâncias salvas no CRM</h2><span>${localInstances.length} exibidas</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${localInstances.map((instance) => `<article class="admin-card">
          <header><div><span class="eyebrow">Instância local</span><h3>${detailValue(instance.name || instance.remote_instance_id)}</h3></div>
            <span class="badge ${instance.enabled ? 'paid' : 'new'}">${instance.enabled ? 'Habilitada' : 'Desabilitada'}</span></header>
          <dl><div><dt>Função</dt><dd>${detailValue(instance.role)}</dd></div>
            <div><dt>Principal</dt><dd>${instance.is_default ? 'Sim' : 'Não'}</dd></div></dl>
          <div class="actions">
            ${!instance.is_default && instance.enabled ? `<form method="post" action="/wa2/local-instances/${esc(instance.id)}/default">${csrfField(csrfToken)}<button>Definir padrão</button></form>` : ''}
            ${instance.enabled ? `<form method="post" action="/wa2/local-instances/${esc(instance.id)}/disable">
              ${csrfField(csrfToken)}${instance.is_default ? '<input type="hidden" name="confirmation" value="DISABLE_DEFAULT_WA2_INSTANCE">' : ''}
              <button class="danger">${instance.is_default ? 'Desabilitar e remover padrão' : 'Desabilitar'}</button></form>`
              : `<form method="post" action="/wa2/local-instances/${esc(instance.id)}/enable">${csrfField(csrfToken)}<button>Habilitar</button></form>`}
          </div><details class="technical-details"><summary>Identificador técnico</summary><p>${esc(instance.remote_instance_id)}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhuma instância salva</h3><p>Valide uma instância disponível para usá-la no CRM.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table>
        <thead><tr><th>Instância</th><th>Função</th><th>Estado local</th><th>Principal</th><th>Ações</th></tr></thead>
        <tbody>${localRows || '<tr><td colspan="5" class="empty">Nenhuma instância validada no CRM.</td></tr>'}</tbody>
      </table></div>
    </section>
  `, { csrfToken });
}

export function wa2LabelBindingsView({
  instances = [],
  selectedInstance = null,
  labels = [],
  bindings = [],
  message = '',
  error = '',
  csrfToken = '',
}) {
  const bindingByStage = new Map(bindings.map((binding) => [binding.stage, binding]));
  const instanceOptions = instances.map((instance) => `
    <option value="${esc(instance.id)}"${selectedInstance?.id === instance.id ? ' selected' : ''}>
      ${detailValue(instance.name || instance.remote_instance_id)}${instance.enabled ? '' : ' · desabilitada'}
    </option>`).join('');
  const incomplete = selectedInstance
    ? WA2_LABEL_STAGES.filter((stage) => !bindingByStage.get(stage)?.enabled).length
    : 0;
  const bindingWarnings = ['NEGOTIATING', 'OPPORTUNITY', 'AWAITING_ENROLLMENT', 'AWAITING_PAYMENT']
    .filter((stage) => bindingByStage.get(stage)?.remote_label_name === 'CRM 02 - Qualificado');
  const stageRows = selectedInstance
    ? WA2_LABEL_STAGES.map((stage) => {
      const expectedName = getWa2StageLabelName(stage);
      const binding = bindingByStage.get(stage) || null;
      const suggestion = labels.find(
        (label) => normalizeWa2LabelName(label.name) === normalizeWa2LabelName(expectedName),
      ) || null;
      const selectedLabelId = binding?.remote_label_id || suggestion?.id || '';
      const labelOptions = labels.map((label) => `
        <option value="${esc(label.id)}"${selectedLabelId === label.id ? ' selected' : ''}>
          ${esc(label.name)} · ${esc(label.id)}
        </option>`).join('');
      return `
        <tr>
          <td><strong>${esc(STAGE_LABELS[stage] || stage)}</strong><small>${esc(expectedName)}</small></td>
          <td>
            ${binding
              ? `${detailValue(binding.remote_label_name)}<small>${esc(binding.remote_label_id)}</small>`
              : '<span class="muted">Não configurado</span>'}
          </td>
          <td>
            ${binding
              ? `<span class="badge ${binding.enabled ? 'enrolled' : 'new'}">${binding.enabled ? 'ATIVO' : 'DESABILITADO'}</span>
                 <small>${esc(binding.lead_count || 0)} lead(s)</small>
                 <small>Verificado: ${formatDateTime(binding.last_verified_at)}</small>
                 <small>Última sincronização: ${formatDateTime(binding.last_sync_at)}</small>
                 ${binding.last_error ? `<small class="error-text">${esc(binding.last_error)}</small>` : ''}`
              : suggestion
                ? '<span class="ok">Correspondência equivalente sugerida; confirme antes de salvar</span>'
                : '<span class="error-text">Sem sugestão automática</span>'}
          </td>
          <td>
            ${labels.length ? `
              <form method="post" action="/wa2/labels/bindings" class="stack compact-form">
                ${csrfField(csrfToken)}
                <input type="hidden" name="instanceId" value="${esc(selectedInstance.id)}">
                <input type="hidden" name="stage" value="${esc(stage)}">
                <select name="remoteLabelId" required>
                  <option value="">Selecione uma etiqueta</option>
                  ${labelOptions}
                </select>
                <button class="small">Validar e salvar</button>
              </form>` : '<span class="muted">Etiquetas WA2 indisponíveis</span>'}
            ${binding ? `
              <div class="actions">
                <form method="post" action="/wa2/label-bindings/${esc(binding.id)}/verify">
                  ${csrfField(csrfToken)}
                  <button class="small">Verificar ID</button>
                </form>
                <form method="post" action="/wa2/label-bindings/${esc(binding.id)}/${binding.enabled ? 'disable' : 'enable'}">
                  ${csrfField(csrfToken)}
                  <button class="small ${binding.enabled ? 'danger' : ''}">${binding.enabled ? 'Desabilitar' : 'Habilitar'}</button>
                </form>
              </div>` : ''}
          </td>
        </tr>`;
    }).join('')
    : '';

  return layout('Etiquetas WA2', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero">
      <div><h1>Etapas CRM → etiquetas WA2</h1><p>Os IDs remotos são confirmados no servidor antes de serem salvos.</p></div>
      ${selectedInstance ? `<div class="meta-box ${incomplete ? 'pending' : 'ready'}"><strong>${incomplete} binding(s) incompleto(s)</strong><span>${detailValue(selectedInstance.name || selectedInstance.remote_instance_id)}</span></div>` : ''}
    </section>
    ${bindingWarnings.length ? `<div class="alert warning">Configuração de binding a revisar: ${bindingWarnings.map((stage) => `${esc(stage)} deve apontar para ${stage === 'NEGOTIATING' ? 'CRM 03' : 'CRM 04'}`).join('; ')}. Nenhuma alteração foi aplicada.</div>` : ''}
    <section class="panel">
      <form method="get" action="/wa2/labels" class="stack compact-form">
        <label>Instância local
          <select name="instanceId" required>
            <option value="">Selecione</option>
            ${instanceOptions}
          </select>
        </label>
        <button>Carregar etiquetas</button>
      </form>
    </section>
    ${selectedInstance ? `
      <section class="panel">
        <div class="panel-title"><h2>Bindings oficiais</h2><div class="actions"><span>${bindings.length} salvos</span><form method="post" action="/wa2/labels/sync">${csrfField(csrfToken)}<input type="hidden" name="instanceId" value="${esc(selectedInstance.id)}"><button>Sincronizar agora</button></form></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Etapa/nome oficial</th><th>Binding atual</th><th>Estado</th><th>Configuração</th></tr></thead>
          <tbody>${stageRows}</tbody>
        </table></div>
      </section>` : '<section class="panel empty">Selecione uma instância para configurar os bindings.</section>'}
  `, { csrfToken });
}

export function wa2LabelJobsView({
  jobs = [],
  counts = {},
  message = '',
  error = '',
  csrfToken = '',
}) {
  const statusLabels = {
    PENDING: 'Pendente',
    RUNNING: 'Processando',
    DONE: 'Concluído',
    FAILED: 'Falhou',
  };
  const rows = jobs.map((job) => `
    <tr>
      <td><strong>${esc(job.lead_name)}</strong><small>${esc(job.id)}</small></td>
      <td>${detailValue(job.target_stage)}<small>${detailValue(job.target_remote_label_id)}</small></td>
      <td>${detailValue(job.instance_name || job.remote_instance_id)}<small>${formatDateTime(job.created_at)}</small></td>
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span>
        ${job.stale ? '<small class="error-text">Processamento travado; elegível para recuperação</small>' : ''}
        <small>${esc(job.attempts)}/${esc(job.max_attempts)} tentativa(s)</small>
        ${job.status === 'PENDING' ? `<small>Próxima: ${formatDateTime(job.available_at)}</small>` : ''}
      </td>
      <td>
        ${job.last_error_code ? `<small class="error-text">${esc(job.last_error_code)} · ${esc(job.last_error_message || '')}</small>` : '—'}
        ${job.status === 'FAILED' && job.attempts < 10 ? `
          <form method="post" action="/wa2/label-jobs/${esc(job.id)}/retry" class="retry-form"
            data-confirm="Enfileirar novamente este job de etiqueta?">
            ${csrfField(csrfToken)}
            <button class="small">Enfileirar novamente</button>
          </form>` : ''}
      </td>
    </tr>`).join('');
  return layout('Jobs de etiquetas WA2', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero"><div><h1>Fila de etiquetas WA2</h1><p>Processamento, retries e falhas da sincronização CRM → WA2.</p></div></section>
    <section class="stats">
      ${stat('Pendentes', counts.pending || 0)}
      ${stat('Processando', counts.running || 0)}
      ${stat('Concluídos', counts.done || 0)}
      ${stat('Falhos', counts.failed || 0)}
      ${stat('Travados', counts.stale || 0)}
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Jobs recentes</h2><span>${jobs.length} exibidos</span></div>
      <div class="admin-card-list mobile-admin-only">
        ${jobs.map((job) => `<article class="admin-card">
          <header><div><span class="eyebrow">Etiqueta WA2</span><h3>${esc(job.lead_name)}</h3></div>
            <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span></header>
          <dl><div><dt>Etapa</dt><dd>${detailValue(job.target_stage)}</dd></div>
            <div><dt>Instância</dt><dd>${detailValue(job.instance_name || job.remote_instance_id)}</dd></div>
            <div><dt>Criado</dt><dd>${formatDateTime(job.created_at)}</dd></div>
            <div><dt>Tentativas</dt><dd>${esc(job.attempts)}/${esc(job.max_attempts)}</dd></div>
            ${job.status === 'PENDING' ? `<div><dt>Próxima tentativa</dt><dd>${formatDateTime(job.available_at)}</dd></div>` : ''}</dl>
          ${job.stale ? '<div class="alert warning">Processamento travado; elegível para recuperação.</div>' : ''}
          ${job.last_error_code ? `<div class="alert error">${esc(job.last_error_code)} · ${esc(job.last_error_message || '')}</div>` : ''}
          ${job.status === 'FAILED' && job.attempts < 10 ? `<form method="post" action="/wa2/label-jobs/${esc(job.id)}/retry"
            data-confirm="Enfileirar novamente este job de etiqueta?">${csrfField(csrfToken)}
            <button>Enfileirar novamente</button></form>` : ''}
          <details class="technical-details"><summary>Identificadores</summary>
            <p>${esc(job.id)} · ${detailValue(job.target_remote_label_id)}</p></details>
        </article>`).join('') || '<div class="empty-state"><h3>Nenhum job de etiqueta</h3><p>As sincronizações aparecerão aqui.</p></div>'}
      </div>
      <div class="table-wrap desktop-admin-only"><table>
        <thead><tr><th>Lead/job</th><th>Etapa/etiqueta</th><th>Instância/data</th><th>Status</th><th>Erro/ação</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty">Nenhum job de etiqueta registrado.</td></tr>'}</tbody>
      </table></div>
    </section>
  `, { csrfToken });
}

export function wa2InstanceView({
  instanceId,
  status,
  message = '',
  error = '',
  csrfToken = '',
}) {
  return layout('Instância WA2', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero">
      <div><h1>${detailValue(status.name || instanceId)}</h1><p>Estado atual da instância WA2.</p></div>
      <span class="badge ${statusClass(status.status)}">${esc(wa2RemoteStatusLabel(status.status))}</span>
    </section>
    <section class="panel detail-grid">
      <div><strong>Telefone</strong><span>${detailValue(status.phone)}</span></div>
      <div><strong>Conectada em</strong><span>${formatDateTime(status.connectedAt)}</span></div>
      <div><strong>Última sincronização</strong><span>${formatDateTime(status.lastSyncAt)}</span></div>
      <div><strong>Requer QR</strong><span>${status.requiresQr ? 'Sim' : 'Não'}</span></div>
      <div><strong>Último código de erro</strong><span>${detailValue(status.lastErrorCode)}</span></div>
      <div><strong>Atualizada em</strong><span>${formatDateTime(status.updatedAt)}</span></div>
    </section>
    <section class="panel">
      <h2>Ações</h2>
      <div class="actions">
        ${status.requiresQr ? `<a class="small button-link" href="/wa2/instances/${encodeURIComponent(instanceId)}/qr">Exibir QR</a>` : ''}
        ${['auto', 'resume', 'new_qr'].map((mode) => `
          <form method="post" action="/wa2/instances/${encodeURIComponent(instanceId)}/connect">
            ${csrfField(csrfToken)}
            <input type="hidden" name="mode" value="${mode}">
            <button class="small">Conectar: ${esc(mode)}</button>
          </form>`).join('')}
        ${['quick', 'catalog', 'history'].map((scope) => `
          <form method="post" action="/wa2/instances/${encodeURIComponent(instanceId)}/sync">
            ${csrfField(csrfToken)}
            <input type="hidden" name="scope" value="${scope}">
            <button class="small">Sincronizar: ${esc(scope)}</button>
          </form>`).join('')}
        <form method="post" action="/wa2/instances/${encodeURIComponent(instanceId)}/disconnect">
          ${csrfField(csrfToken)}
          <button class="small danger">Desconectar preservando sessão</button>
        </form>
        <form method="post" action="/wa2/instances/${encodeURIComponent(instanceId)}/delete"
          data-confirm="Excluir esta instância do WA2 e ocultá-la no CRM?">
          ${csrfField(csrfToken)}
          <input type="hidden" name="confirmation" value="DELETE_WA2_INSTANCE">
          <button class="small danger">Excluir instância</button>
        </form>
      </div>
    </section>
    <a href="/wa2">Voltar para instâncias</a>
  `, { csrfToken });
}

export function wa2QrView({ instanceId, status, error = '', csrfToken = '' }) {
  return layout('QR WA2', `
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero">
      <div><h1>QR da instância</h1><p>O QR é consultado no WA2 e não é armazenado pelo CRM.</p></div>
      <span class="badge ${statusClass(status.status)}">${detailValue(status.status)}</span>
    </section>
    <section class="panel qr-panel" data-auto-refresh-ms="${['connecting', 'qr'].includes(String(status.status || '').toLowerCase()) ? '3000' : '0'}">
      ${status.requiresQr
        ? `<img class="qr-image" src="/wa2/instances/${encodeURIComponent(instanceId)}/qr/image" alt="QR temporário da instância WA2" referrerpolicy="no-referrer">`
        : `<p>${String(status.status || '').toLowerCase() === 'connected'
          ? 'WhatsApp conectado.'
          : 'Preparando QR no worker do WA2...'}</p>`}
      <p class="muted">O QR pode expirar. Atualize esta página para consultar novamente o estado da instância.</p>
      <div class="actions">
        <a class="small button-link" href="/wa2/instances/${encodeURIComponent(instanceId)}/qr">Atualizar estado</a>
        <a class="small button-link" href="/wa2/instances/${encodeURIComponent(instanceId)}">Voltar aos detalhes</a>
      </div>
    </section>
  `, { csrfToken });
}

function maskJid(value) {
  const jid = String(value || '');
  const [phone, domain] = jid.split('@');
  if (!phone || !domain) return '—';
  const visible = phone.length > 6
    ? `${phone.slice(0, 4)}••••${phone.slice(-2)}`
    : '••••';
  return `${visible}@${domain}`;
}

export function leadWa2View({
  lead,
  instances,
  links,
  labelSync = [],
  message = '',
  error = '',
  csrfToken = '',
}) {
  const linkRows = links.map((link) => `
    <tr>
      <td>${detailValue(link.instance_name || link.remote_instance_id)}</td>
      <td>${detailValue(link.remote_contact_id)}</td>
      <td>${detailValue(link.remote_chat_id)}<small>${esc(maskJid(link.jid))}</small></td>
      <td>${formatDateTime(link.last_verified_at)}</td>
      <td>
        <div class="actions">
          <form method="post" action="/leads/${esc(lead.id)}/wa2/verify">
            ${csrfField(csrfToken)}
            <input type="hidden" name="linkId" value="${esc(link.id)}">
            <button class="small">Verificar</button>
          </form>
          <form method="post" action="/leads/${esc(lead.id)}/wa2/unlink">
            ${csrfField(csrfToken)}
            <input type="hidden" name="linkId" value="${esc(link.id)}">
            <input type="hidden" name="confirmation" value="UNLINK_WA2">
            <button class="small danger">Desvincular</button>
          </form>
        </div>
      </td>
    </tr>`).join('');
  const instanceOptions = instances.map((instance) =>
    `<option value="${esc(instance.id)}">${detailValue(instance.name || instance.remote_instance_id)}${instance.is_default ? ' · padrão' : ''}</option>`).join('');
  const labelSyncRows = labelSync.map((sync) => `
    <tr>
      <td>${detailValue(sync.instance_name)}</td>
      <td>
        ${sync.binding_id
          ? `${detailValue(sync.remote_label_name)}<small>${detailValue(sync.remote_label_id)}</small>`
          : '<span class="error-text">Etapa sem binding configurado</span>'}
      </td>
      <td>
        ${sync.job_id
          ? `<span class="badge ${statusClass(sync.job_status)}">${detailValue(sync.job_status)}</span><small>${detailValue(sync.job_attempts)} tentativa(s)</small>`
          : '<span class="muted">Nenhum job registrado</span>'}
      </td>
      <td>${sync.last_error_code
        ? `<small class="error-text">${esc(sync.last_error_code)} · ${esc(sync.last_error_message || '')}</small>`
        : '—'}</td>
    </tr>`).join('');

  return layout('Vínculo WA2', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero">
      <div><h1>WhatsApp/WA2 · ${esc(lead.name)}</h1><p>Vínculo manual com contato e chat individual.</p></div>
    </section>
    <section class="panel detail-grid">
      <div><strong>Telefone bruto</strong><span>${detailValue(lead.phone)}</span></div>
      <div><strong>Telefone normalizado</strong><span>${detailValue(lead.phone_normalized)}</span></div>
      <div><strong>Origem do lead</strong><span>${detailValue(lead.source)}</span></div>
    </section>
    <section class="panel">
      <h2>Resolver contato no WA2</h2>
      ${instances.length ? `
        <form method="post" action="/leads/${esc(lead.id)}/wa2/resolve" class="stack compact-form">
          ${csrfField(csrfToken)}
          <label>Instância local habilitada
            <select name="instanceId" required>${instanceOptions}</select>
          </label>
          <button type="submit">Consultar contato e chat</button>
        </form>`
        : '<p class="muted">Salve e habilite uma instância WA2 antes de resolver o contato.</p>'}
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Vínculos ativos</h2><span>${links.length}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Instância</th><th>Contato remoto</th><th>Chat/JID</th><th>Última verificação</th><th>Ações</th></tr></thead>
        <tbody>${linkRows || '<tr><td colspan="5" class="empty">Nenhum vínculo ativo.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Sincronização da etapa atual</h2><span>${labelSync.length} instância(s)</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Instância</th><th>Binding</th><th>Último job</th><th>Erro</th></tr></thead>
        <tbody>${labelSyncRows || '<tr><td colspan="4" class="empty">Sem vínculo WA2 ativo para observar.</td></tr>'}</tbody>
      </table></div>
    </section>
    <a href="/">Voltar aos leads</a>
  `, { csrfToken });
}

export function wa2LinkConfirmView({
  lead,
  instance,
  resolved,
  phoneNormalized,
  currentLink = null,
  expectedAction,
  expectedLinkId,
  resolutionToken,
  csrfToken = '',
}) {
  return layout('Confirmar vínculo WA2', `
    <section class="hero">
      <div>
        <h1>${currentLink ? 'Confirmar substituição' : 'Confirmar vínculo'} WA2</h1>
        <p>Os dados serão consultados novamente no WA2 ao confirmar.</p>
      </div>
    </section>
    <section class="panel detail-grid">
      <div><strong>Lead</strong><span>${esc(lead.name)}</span></div>
      <div><strong>Telefone</strong><span>${esc(phoneNormalized)}</span></div>
      <div><strong>Instância</strong><span>${detailValue(instance.name || instance.remote_instance_id)}</span></div>
      <div><strong>Contato remoto</strong><span>${detailValue(resolved.contact.id)}</span></div>
      <div><strong>Nome remoto</strong><span>${detailValue(resolved.contact.name)}</span></div>
      <div><strong>Chat remoto</strong><span>${detailValue(resolved.chat.id)}</span></div>
      <div><strong>JID</strong><span>${esc(maskJid(resolved.chat.jid))}</span></div>
    </section>
    ${currentLink ? '<div class="alert error">A confirmação substituirá logicamente o vínculo ativo nesta instância sem apagar seu histórico.</div>' : ''}
    <div class="actions">
      <form method="post" action="/leads/${esc(lead.id)}/wa2/confirm">
        ${csrfField(csrfToken)}
        <input type="hidden" name="instanceId" value="${esc(instance.id)}">
        <input type="hidden" name="expectedAction" value="${esc(expectedAction)}">
        <input type="hidden" name="expectedLinkId" value="${esc(expectedLinkId || '')}">
        <input type="hidden" name="resolutionToken" value="${esc(resolutionToken)}">
        <input type="hidden" name="confirmation" value="CONFIRM_WA2_LINK">
        <button type="submit" class="success">${currentLink ? 'Confirmar substituição' : 'Confirmar vínculo'}</button>
      </form>
      <a class="small button-link" href="/leads/${esc(lead.id)}/wa2">Cancelar</a>
    </div>
  `, { csrfToken });
}
