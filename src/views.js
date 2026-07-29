import {
  LOST_REASON_LABELS,
  STAGE_LABELS,
  STAGES,
  getStageActions,
  getStageBadgeClass,
} from './funnel.js';
import { selectBestLeadPhone } from './phone.js';
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

const ICON_PATHS = Object.freeze({
  whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-4.6A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.5 8.5c.5 3 2 4.5 5 5l1.5-1.5 2 1v2c0 1-1 2-2 2A10 10 0 0 1 7 9c0-1 1-2 2-2h2l1 2-1.5 1.5"/>',
  stage: '<path d="M4 7h10"/><path d="m11 4 3 3-3 3"/><path d="M20 17H10"/><path d="m13 14-3 3 3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  details: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
  wa2: '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M16 3h5v5"/>',
  close: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  alert: '<path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
});

function icon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function layout(title, body, { logged = true, csrfToken = '' } = {}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · CRM Super Educar</title>
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js" defer></script>
</head>
<body>
  ${logged ? `<header><strong>CRM Meta · Super Educar</strong><nav><a href="/">Leads</a><a href="/meta/connections">Conexões Meta</a><a href="/events">Eventos Meta</a><a href="/wa2">WA2</a><a href="/wa2/labels">Etiquetas WA2</a><a href="/wa2/label-jobs">Jobs WA2</a><a href="/operations">Importação e reconciliação</a><form method="post" action="/logout">${csrfField(csrfToken)}<button class="link">Sair</button></form></nav></header>` : ''}
  <main>${body}</main>
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

function stat(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
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

export function historicalOperationsView({
  operations,
  instances,
  metaForms = [],
  message = '',
  error = '',
  csrfToken = '',
}) {
  const cursor = operations.cursor;
  return layout('Importação e reconciliação', `
    <section class="hero"><div><h1>Importação histórica e WA2</h1>
      <p>Operações retomáveis por tenant, executadas em lotes pelo worker.</p></div></section>
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="panel">
      <h2>Importação Meta</h2>
      <form method="post" action="/operations/meta-imports" class="stack">
        ${csrfField(csrfToken)}
        <label>Conexão, página e formulários
          <select name="formRecordIds" multiple required size="${Math.min(Math.max(metaForms.length, 3), 8)}">
            ${metaForms.map((form) => `<option value="${esc(form.id)}">${esc(form.connection_name)} · ${esc(form.page_name)} · ${esc(form.name)}</option>`).join('')}
          </select>
        </label>
        <label>Início do período<input type="date" name="periodStart"></label>
        <label>Fim do período<input type="date" name="periodEnd"></label>
        <button type="submit">Iniciar importação</button>
      </form>
      <table><thead><tr><th>Form</th><th>Status</th><th>Recebidos</th>
        <th>Criados</th><th>Atualizados</th><th>Inválidos</th><th>Cursor</th><th>Ação</th></tr></thead>
        <tbody>${operations.imports.map((run) => `<tr>
          <td>${esc(run.form_id)}</td><td>${esc(run.status)}</td>
          <td>${esc(run.received_count)}</td><td>${esc(run.created_count)}</td>
          <td>${esc(run.updated_count)}</td><td>${esc(run.invalid_count)}</td>
          <td>${esc(run.cursor_value || '—')}</td><td>
          ${['PAUSED', 'FAILED'].includes(run.status) ? `<form method="post" action="/operations/meta-imports/${esc(run.id)}/resume">${csrfField(csrfToken)}<button>Retomar</button></form>` : ''}
          ${['PENDING', 'PAUSED'].includes(run.status) ? `<form method="post" action="/operations/meta-imports/${esc(run.id)}/cancel">${csrfField(csrfToken)}<button>Cancelar</button></form>` : ''}
          </td></tr>`).join('')}</tbody></table>
    </section>
    <section class="panel">
      <h2>Eventos WhatsApp</h2>
      <p>Cursor: ${esc(cursor?.cursor_value || 'inicial')} · Status: ${esc(cursor?.status || 'IDLE')}</p>
      <p><strong>${esc(cursor?.ignored_count || 0)} eventos internos ignorados por não representarem alteração comercial.</strong></p>
      <p>Processados: ${esc(cursor?.processed_count || 0)} · Conflitos: ${esc(cursor?.conflict_count || 0)} ·
        Pendências: ${esc(cursor?.pending_count || 0)} · Erro atual: ${detailValue(cursor?.last_error_code)}</p>
    </section>
    <section class="panel">
      <h2>Reconciliação WA2</h2>
      <form method="post" action="/operations/reconciliations" class="stack">
        ${csrfField(csrfToken)}
        <label>Instância<select name="instanceId" required>
          ${instances.filter((item) => item.enabled).map((item) =>
            `<option value="${esc(item.id)}">${esc(item.name || item.remote_instance_id)}</option>`).join('')}
        </select></label><button type="submit">Iniciar lote</button>
      </form>
      <table><thead><tr><th>Instância</th><th>Status</th><th>Progresso</th>
        <th>Resultados</th><th>Ação</th></tr></thead><tbody>
        ${operations.reconciliations.map((run) => `<tr>
          <td><strong>${esc(run.instance_name)}</strong><small>Job ${esc(run.id)}</small><small>Criado: ${detailValue(run.created_at)}</small><small>Tenant: ${detailValue(run.tenant_id)}</small></td><td>${esc({
            PENDING: 'Pendente', RUNNING: 'Processando', COMPLETED: 'Concluído',
            PARTIAL: 'Concluído com pendências', FAILED: 'Falhou', CANCELLED: 'Cancelado',
          }[run.status] || run.status)}<small>Início: ${detailValue(run.started_at)} · Fim: ${detailValue(run.completed_at)}</small><small>Lock: ${detailValue(run.locked_at)} · Heartbeat: ${detailValue(run.heartbeat_at)}</small></td>
          <td>${esc(run.processed_count)}/${esc(run.total_count)}<small>Duração: ${esc(operationDuration(run.started_at, run.completed_at))} · ${esc(run.retry_count || 0)} retry(s)</small>${run.last_error ? `<small class="error-text">${esc(run.last_error)}</small>` : ''}</td>
          <td>${Object.entries(run.results || {}).map(([result, count]) => `<div><strong>${esc(count)}</strong> · <a href="/operations/reconciliations/${esc(run.id)}/items?result=${esc(result)}">${esc({
            MATCHED: 'Correspondências encontradas', UPDATED: 'Leads atualizados',
            PHONE_EMPTY: 'Telefone vazio', PHONE_INVALID: 'Telefone inválido',
            NOT_FOUND_IN_WA2: 'Não encontrado no WA2', LID_UNRESOLVED: 'LID não resolvido',
            LABEL_UNMAPPED: 'Etiqueta sem vínculo', CONFLICT: 'Conflito', ERROR: 'Erro',
          }[result] || result)}</a></div>`).join('') || 'Sem resultados'}<small><a href="/operations/reconciliations/${esc(run.id)}/errors.csv">Exportar erros CSV</a></small></td>
          <td><form method="post" action="/operations/reconciliations/${esc(run.id)}/retry">
            ${csrfField(csrfToken)}<button${!['PARTIAL','FAILED'].includes(run.status) ? ' disabled title="Não há falhas elegíveis para retry"' : ''}>Retry falhas</button></form></td></tr>`).join('')}
      </tbody></table>
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
        ${items.map((item) => `<tr><td><a href="/leads/${esc(item.lead_id)}">${esc(item.lead_name)}</a><small>${esc(item.lead_id)}</small></td><td>${esc(labels[item.result] || item.result || 'Pendente')}</td><td>${esc(item.attempts)}</td><td>${detailValue(item.last_error_code)}</td><td>${detailValue(item.finished_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum registro.</td></tr>'}
      </tbody></table></div>
    </section>
    <div class="actions"><a class="button-link secondary" href="/operations">Voltar</a><a class="button-link" href="/operations/reconciliations/${esc(runId)}/errors.csv">Exportar erros CSV</a></div>
  `, { csrfToken });
}

function whatsappAction(lead, csrfToken) {
  const phone = selectBestLeadPhone(lead);
  if (!phone.phoneNormalized) {
    return `
      <button type="button" class="action-button whatsapp" disabled>
        ${icon('whatsapp')}<span>Abrir no WhatsApp</span>
      </button>
      <p class="action-status error-text" role="alert">${icon('alert')} Telefone inválido</p>`;
  }
  return `<form method="post" action="/leads/${esc(lead.id)}/whatsapp" target="_blank" rel="noopener noreferrer" data-whatsapp-form>
    ${csrfField(csrfToken)}
    <button class="action-button whatsapp primary-action" type="submit" data-whatsapp-submit>
      ${icon('whatsapp')}<span data-button-label>Abrir no WhatsApp</span>
    </button>
    <button class="fallback-action" type="submit" formtarget="_self" data-whatsapp-fallback hidden>
      Abrir nesta aba
    </button>
    <p class="action-status" role="status" aria-live="polite" aria-atomic="true" data-whatsapp-status></p>
  </form>`;
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
    'search', 'course', 'city', 'stage', 'lostReason', 'instanceId', 'labelId',
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

function stageActions(lead, csrfToken) {
  const actions = getStageActions(lead.stage).filter(
    ({ stage }) => !['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(stage),
  );
  if (actions.length === 0) {
    return `<button type="button" class="action-button action-secondary" disabled>
      ${icon('stage')}<span>Sem transição disponível</span>
    </button>`;
  }
  return `<details class="action-disclosure" data-action-disclosure>
    <summary class="action-button action-secondary">
      ${icon('stage')}<span>Atualizar etapa</span>${icon('chevron')}
    </summary>
    <div class="action-menu">
      ${actions.map(({ stage, label }) => `
      <form method="post" action="/leads/${esc(lead.id)}/stage">
      ${csrfField(csrfToken)}
      <input type="hidden" name="stage" value="${stage}">
      <button class="action-menu-item">${icon('stage')}<span>${esc(label)}</span></button>
      </form>`).join('')}
    </div>
  </details>`;
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
      <hr>
      <button type="button" class="action-menu-item action-menu-danger" data-lost-lead="${esc(lead.id)}">
        ${icon('close')}<span>Encerrar lead</span>
      </button>
    </div>
  </details>`;
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
  const rows = leads.map((lead) => {
    const arrival = formatArrival(lead.received_at || lead.created_at);
    return `
      <tr>
        <td data-label="Selecionar"><input class="lead-select" form="bulk-leads" type="checkbox" name="leadIds" value="${esc(lead.id)}" aria-label="Selecionar ${esc(lead.name)}"></td>
        <td data-label="Lead">
          <strong><a href="/leads/${esc(lead.id)}">${esc(lead.name)}</a></strong>
          <small>${esc(lead.phone || 'Sem telefone')}${lead.email ? `<br>${esc(lead.email)}` : ''}</small>
        </td>
        <td data-label="Interesse"><strong>${esc(lead.course || '—')}</strong><small>${esc(lead.city || 'Cidade não informada')}</small></td>
        <td data-label="Chegada">${esc(arrival.date)}${arrival.time ? `<small>${esc(arrival.time)}</small>` : ''}</td>
        <td data-label="Origem">
          ${esc(sourceLabel(lead.source))}
          <small>${lead.meta_lead_id ? `Lead Meta: ${esc(lead.meta_lead_id)}` : 'Sem atribuição Meta'}</small>
          <small>Conexão: ${metadataValue(lead.meta_connection_name)}</small>
          <small>BM: ${metadataValue(lead.meta_business_id || lead.business_id)}</small>
        </td>
        <td data-label="Campanha" class="metadata-cell">
          <span>Campanha: ${metadataValue(lead.meta_campaign_id)}</span>
          <small>Conjunto: ${metadataValue(lead.meta_adset_id)}</small>
          <small>Anúncio: ${metadataValue(lead.meta_ad_id)}</small>
        </td>
        <td data-label="Página/formulário" class="metadata-cell">
          <span>Página: ${metadataValue(lead.meta_page_name || lead.meta_page_id)}</span>
          <small>Formulário: ${metadataValue(lead.meta_form_name || lead.meta_form_id)}</small>
          <small>Instância WA2: ${metadataValue(lead.wa2_instance_name)}</small>
        </td>
        <td data-label="Etapa"><span class="badge ${esc(getStageBadgeClass(lead.stage))}">${esc(STAGE_LABELS[lead.stage] || lead.stage)}</span>${lead.lost_reason ? `<small>Motivo: ${esc(LOST_REASON_LABELS[lead.lost_reason] || lead.lost_reason)}</small>` : ''}</td>
        <td data-label="Ações" class="actions-cell">
          <div class="lead-actions" data-lead-actions>
            <div class="whatsapp-action">${whatsappAction(lead, csrfToken)}</div>
            <div class="lead-secondary-actions">
              ${stageActions(lead, csrfToken)}
              ${moreLeadActions(lead)}
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');

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

    <section class="panel">
      <div class="panel-title"><div><h2>Filtros</h2><small>Consultas paginadas e isoladas por tenant.</small></div></div>
      <form method="get" action="/" class="filter-grid">
        <label>Busca<input name="search" value="${esc(filters.search || '')}" placeholder="Nome, telefone, e-mail ou curso"></label>
        <label>Curso/interesse<input name="course" value="${esc(filters.course || '')}"></label>
        <label>Cidade<input name="city" value="${esc(filters.city || '')}"></label>
        <label>Etapa<select name="stage"><option value="">Todas</option>${Object.entries(STAGE_LABELS).map(([value, label]) => `<option value="${value}"${filters.stage === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Motivo da perda<select name="lostReason"><option value="">Todos</option>${Object.entries(LOST_REASON_LABELS).map(([value, label]) => `<option value="${value}"${filters.lostReason === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
        <label>Instância WA2<select name="instanceId"><option value="">Todas</option>${wa2Instances.map((instance) => `<option value="${esc(instance.id)}"${filters.instanceId === instance.id ? ' selected' : ''}>${detailValue(instance.name || instance.remote_instance_id)}</option>`).join('')}</select></label>
        <label>Etiqueta WA2 (ID)<input name="labelId" value="${esc(filters.labelId || '')}"></label>
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
        <button type="submit">Aplicar filtros</button>
        <a class="button-link secondary" href="/">Limpar</a>
      </form>
    </section>

    <section class="stats">
      ${stat('Total', counts.total)}${stat('Novos', counts.new)}${stat('Em atendimento', counts.in_service)}${stat('Qualificados', counts.qualified)}${stat('Oportunidades', counts.opportunities)}${stat('Matriculados', counts.enrolled)}${stat('Pagos', counts.paid)}${stat('Perdidos', counts.lost)}${stat('Taxa de qualificação', `${counts.qualificationRate}%`)}${stat('Taxa de matrícula', `${counts.matriculationRate}%`)}${stat('Eventos pendentes', counts.metaPending)}${stat('Eventos em nova tentativa', counts.metaRetry)}${stat('Eventos com falha', counts.metaFailed)}
    </section>

    <section class="panel">
      <h2>Novo lead manual</h2>
      <form method="post" action="/leads" class="grid-form">
        ${csrfField(csrfToken)}
        <label>Nome<input name="name" required></label>
        <label>Telefone<input name="phone"></label>
        <label>E-mail<input name="email" type="email"></label>
        <label>Curso<input name="course"></label>
        <label>Cidade<input name="city"></label>
        <button type="submit">Adicionar lead</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-title"><div><h2>Mensagem inicial do WhatsApp</h2><small>Configuração isolada deste tenant. Use {{nome}} para personalizar.</small></div></div>
      <form method="post" action="/settings/whatsapp-message" class="compact-form stack">
        ${csrfField(csrfToken)}
        <textarea name="message" required maxlength="1000">${esc(whatsappMessage)}</textarea>
        <button>Salvar mensagem</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-title">
        <div>
          <h2>Leads recentes</h2>
          ${operationStartAt ? `<small>Operação iniciada em ${esc(new Date(operationStartAt).toLocaleString('pt-BR'))}. Leads anteriores permanecem armazenados.</small>` : ''}
        </div>
        <span>${leads.length} exibidos</span>
      </div>
      <form id="bulk-leads" method="post" action="/leads/bulk" class="bulk-toolbar" data-confirm="Aplicar esta ação a todos os leads selecionados?">
        ${csrfField(csrfToken)}
        <strong>Ações em lote</strong>
        <select name="bulkAction" required><option value="stage">Alterar etapa</option><option value="sync">Sincronizar etiqueta WA2</option></select>
        <select name="stage"><option value="">Selecione a etapa...</option>${Object.entries(STAGE_LABELS).filter(([stage]) => !['ENROLLED','PAID'].includes(stage)).map(([stage, label]) => `<option value="${stage}">${esc(label)}</option>`).join('')}</select>
        <select name="lostReason"><option value="">Motivo da perda...</option>${Object.entries(LOST_REASON_LABELS).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select>
        <input name="lostNotes" maxlength="1000" placeholder="Observação quando Outro">
        <button>Aplicar aos selecionados</button>
        <a class="button-link secondary" href="/leads/export.csv?${esc(dashboardFilterQuery(filters))}">Exportar CSV</a>
      </form>
      <div class="table-wrap"><table class="leads-table">
        <thead><tr><th><span class="sr-only">Selecionar</span></th><th>Lead</th><th>Interesse</th><th>Chegada</th><th>Origem/Meta</th><th>Campanha</th><th>Página/formulário</th><th>Etapa</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="empty">Nenhum lead encontrado.</td></tr>'}</tbody>
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
      <small>${esc(new Date(item.changed_at).toLocaleString('pt-BR'))} · ${esc(item.origin || '—')} · ${esc(item.changed_by || 'Sistema')}</small>
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
    </section>
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
      <div class="table-wrap"><table><thead><tr><th>Conexão/BM</th><th>Status</th><th>Recursos</th><th>Último erro</th><th>Ações</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">Nenhuma conexão cadastrada.</td></tr>'}</tbody></table></div>
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
        <div class="table-wrap"><table><thead><tr><th>Dataset</th><th>ID</th><th>Estado</th><th>Última validação</th><th>Erro/ação</th></tr></thead><tbody>${selected.datasets.map((dataset) => `<tr><td>${esc(dataset.name)}</td><td>${esc(dataset.dataset_id)}</td><td>${dataset.active ? 'Ativo' : 'Inativo'}</td><td>${dataset.last_test_at ? esc(new Date(dataset.last_test_at).toLocaleString('pt-BR')) : '—'}</td><td>${detailValue(dataset.last_error)}${dataset.active ? `<form method="post" action="/meta/connections/${esc(selected.id)}/datasets/${esc(dataset.id)}/validate">${csrfField(csrfToken)}<button class="small">Validar dataset</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum dataset configurado.</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel"><h2>Renovar token</h2><form method="post" action="/meta/connections/${esc(selected.id)}/token" class="compact-form stack">${csrfField(csrfToken)}<label>Novo access token<input name="accessToken" type="password" required autocomplete="new-password"></label><button>Validar e substituir</button></form></section>
    ` : ''}
  `, { csrfToken });
}

function statusClass(status) {
  if (['SENT', 'COMPLETED', 'DONE'].includes(status)) return 'paid';
  if (status === 'FAILED') return 'lost';
  if (status === 'RETRY') return 'contact-started';
  if (['PROCESSING', 'RUNNING'].includes(status)) return 'opportunity';
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
      <td>${event.sent_at ? esc(new Date(event.sent_at).toLocaleString('pt-BR')) : '—'}${event.last_error ? `<small class="error-text">${esc(event.last_error)}</small>` : ''}</td>
    </tr>`).join('');

  const jobRows = jobs.map((job) => `
    <tr>
      <td>
        <strong>${job.job_type === 'LEAD_IMPORT' ? 'Importação de lead' : esc(job.event_name || 'Conversão')}</strong>
        <small>${job.event_id ? `${job.event_id.endsWith(':test') ? 'TESTE' : 'PRODUÇÃO'} · ` : ''}${esc(job.meta_lead_id || job.id)}</small>
      </td>
      <td>${esc(job.lead_name || '—')}<small>${esc(new Date(job.created_at).toLocaleString('pt-BR'))}</small></td>
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span>
        <small>${esc(job.attempts)} tentativa(s)${job.status === 'RETRY' ? `<br>Próxima: ${esc(new Date(job.next_attempt_at).toLocaleString('pt-BR'))}` : ''}</small>
      </td>
      <td>
        ${job.last_error ? `<small class="error-text">${esc(job.last_error)}</small>` : '—'}
        ${job.status === 'FAILED' ? `
          <form method="post" action="/jobs/${job.id}/retry" class="retry-form">
            ${csrfField(csrfToken)}
            <button type="submit" class="small">Reenviar</button>
          </form>` : ''}
      </td>
    </tr>`).join('');

  return layout('Eventos Meta', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}
    <section class="hero"><div><h1>Eventos e fila Meta</h1><p>Conversões e importações são processadas de forma assíncrona pelo worker.</p></div></section>
    <section class="panel">
      <div class="panel-title"><h2>Fila persistente</h2><span>${jobs.length} exibidos</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Job</th><th>Lead/criação</th><th>Status</th><th>Erro/ação</th></tr></thead>
        <tbody>${jobRows || '<tr><td colspan="4" class="empty">Nenhum job registrado.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section class="panel"><div class="table-wrap"><table>
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
    <div class="actions">
      <a class="button-link" href="/wa2/labels">Configurar etiquetas CRM</a>
      <a class="button-link" href="/wa2/label-jobs">Acompanhar jobs de etiquetas</a>
    </div>
    <section class="panel">
      <div class="panel-title"><h2>Instâncias</h2><span>${instances.length} exibidas</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Instância</th><th>Função</th><th>Telefone</th><th>Status</th><th>Principal</th><th>Ação</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">Nenhuma instância disponível.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section class="panel">
      <div class="panel-title"><h2>Instâncias salvas no CRM</h2><span>${localInstances.length} exibidas</span></div>
      <div class="table-wrap"><table>
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
                 <small>Verificado: ${detailValue(binding.last_verified_at)}</small>
                 <small>Última sincronização: ${detailValue(binding.last_sync_at)}</small>
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
      <td>${detailValue(job.instance_name || job.remote_instance_id)}<small>${detailValue(job.created_at)}</small></td>
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(statusLabels[job.status] || job.status)}</span>
        ${job.stale ? '<small class="error-text">Processamento travado; elegível para recuperação</small>' : ''}
        <small>${esc(job.attempts)}/${esc(job.max_attempts)} tentativa(s)</small>
        ${job.status === 'PENDING' ? `<small>Próxima: ${detailValue(job.available_at)}</small>` : ''}
      </td>
      <td>
        ${job.last_error_code ? `<small class="error-text">${esc(job.last_error_code)} · ${esc(job.last_error_message || '')}</small>` : '—'}
        ${job.status === 'FAILED' && job.attempts < 10 ? `
          <form method="post" action="/wa2/label-jobs/${esc(job.id)}/retry" class="retry-form">
            ${csrfField(csrfToken)}
            <button class="small">Reenviar</button>
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
      <div class="table-wrap"><table>
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
      <div><strong>Conectada em</strong><span>${detailValue(status.connectedAt)}</span></div>
      <div><strong>Última sincronização</strong><span>${detailValue(status.lastSyncAt)}</span></div>
      <div><strong>Requer QR</strong><span>${status.requiresQr ? 'Sim' : 'Não'}</span></div>
      <div><strong>Último código de erro</strong><span>${detailValue(status.lastErrorCode)}</span></div>
      <div><strong>Atualizada em</strong><span>${detailValue(status.updatedAt)}</span></div>
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
    <section class="panel qr-panel">
      ${status.requiresQr
        ? `<img class="qr-image" src="/wa2/instances/${encodeURIComponent(instanceId)}/qr/image" alt="QR temporário da instância WA2" referrerpolicy="no-referrer">`
        : '<p>Esta instância não solicita QR no momento.</p>'}
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
      <td>${detailValue(link.last_verified_at)}</td>
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
