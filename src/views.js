import {
  STAGE_LABELS,
  STAGES,
  getStageActions,
  getStageBadgeClass,
} from './funnel.js';
import { getWhatsAppUrl } from './phone.js';
import {
  WA2_LABEL_STAGES,
  getWa2StageLabelName,
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

function layout(title, body, { logged = true, csrfToken = '' } = {}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · CRM Super Educar</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  ${logged ? `<header><strong>CRM Meta · Super Educar</strong><nav><a href="/">Leads</a><a href="/events">Eventos Meta</a><a href="/wa2">WA2</a><a href="/wa2/labels">Etiquetas WA2</a><a href="/wa2/label-jobs">Jobs WA2</a><form method="post" action="/logout">${csrfField(csrfToken)}<button class="link">Sair</button></form></nav></header>` : ''}
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

function whatsappAction(phone) {
  const whatsappUrl = getWhatsAppUrl(phone);
  if (!whatsappUrl) {
    return `
      <span class="small button-link whatsapp disabled" aria-disabled="true">Conversar</span>
      <small class="action-note error-text">Telefone inválido</small>`;
  }
  return `<a class="small button-link whatsapp" href="${esc(whatsappUrl)}" target="_blank" rel="noopener noreferrer">Conversar</a>`;
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

function stageActions(lead, csrfToken) {
  const actions = getStageActions(lead.stage);
  if (actions.length === 0) return '<span class="muted">Etapa final</span>';
  return actions.map(({ stage, label }) => stage === STAGES.MATRICULATED
    ? `<a class="small button-link success" href="/leads/${esc(lead.id)}/matriculate">${label}</a>`
    : `
    <form method="post" action="/leads/${esc(lead.id)}/stage">
      ${csrfField(csrfToken)}
      <input type="hidden" name="stage" value="${stage}">
      <button class="small ${stage === 'LOST' ? 'danger' : ''}">${label}</button>
    </form>`).join('');
}

export function dashboardView({
  leads,
  counts,
  metaStatus,
  message = '',
  error = '',
  operationStartAt = null,
  csrfToken = '',
}) {
  const rows = leads.map((lead) => {
    const arrival = formatArrival(lead.received_at || lead.created_at);
    return `
      <tr>
        <td data-label="Lead">
          <strong>${esc(lead.name)}</strong>
          <small>${esc(lead.phone || 'Sem telefone')}${lead.email ? `<br>${esc(lead.email)}` : ''}</small>
          <small>Curso/produto: ${esc(lead.course || '—')}${lead.city ? `<br>Cidade: ${esc(lead.city)}` : ''}</small>
        </td>
        <td data-label="Chegada">${esc(arrival.date)}${arrival.time ? `<small>${esc(arrival.time)}</small>` : ''}</td>
        <td data-label="Origem">
          ${esc(sourceLabel(lead.source))}
          <small>${lead.meta_lead_id ? `Lead Meta: ${esc(lead.meta_lead_id)}` : 'Sem atribuição Meta'}</small>
        </td>
        <td data-label="Campanha" class="metadata-cell">
          <span>Campanha: ${metadataValue(lead.meta_campaign_id)}</span>
          <small>Conjunto: ${metadataValue(lead.meta_adset_id)}</small>
          <small>Anúncio: ${metadataValue(lead.meta_ad_id)}</small>
          <small>Formulário: ${metadataValue(lead.meta_form_id)}</small>
        </td>
        <td data-label="Etapa"><span class="badge ${esc(getStageBadgeClass(lead.stage))}">${esc(STAGE_LABELS[lead.stage] || lead.stage)}</span></td>
        <td data-label="Ações">
          <div class="actions">
            <div class="whatsapp-action">${whatsappAction(lead.phone)}</div>
            <a class="small button-link" href="/leads/${esc(lead.id)}/wa2">WhatsApp/WA2</a>
            ${stageActions(lead, csrfToken)}
          </div>
        </td>
      </tr>`;
  }).join('');

  return layout('Leads', `
    ${message ? `<div class="alert success">${esc(message)}</div>` : ''}
    ${error ? `<div class="alert error">${esc(error)}</div>` : ''}

    <section class="hero">
      <div><h1>Leads e conversões</h1><p>Marque o lead como qualificado ou matriculado para enviar o estágio à Meta.</p></div>
      <div class="meta-box ${metaStatus.configured ? 'ready' : 'pending'}">
        <strong>${metaStatus.configured ? 'Meta configurada' : 'Meta pendente'}</strong>
        <span>Graph ${esc(metaStatus.graphVersion)} · ${metaStatus.testMode ? 'MODO TESTE' : 'PRODUÇÃO'}</span>
        ${metaStatus.missing.length ? `<small>Faltando: ${esc(metaStatus.missing.join(', '))}</small>` : ''}
      </div>
    </section>

    <section class="stats">
      ${stat('Total', counts.total)}${stat('Novos', counts.new)}${stat('Qualificados', counts.qualified)}${stat('Inscrições vestibular', counts.vestibular_registered)}${stat('Vestibulares concluídos', counts.vestibular_completed)}${stat('Matriculados', counts.matriculated)}${stat('Perdidos', counts.lost)}${stat('Taxa de qualificação', `${counts.qualificationRate}%`)}${stat('Taxa de matrícula', `${counts.matriculationRate}%`)}${stat('Eventos pendentes', counts.metaPending)}${stat('Eventos em nova tentativa', counts.metaRetry)}${stat('Eventos com falha', counts.metaFailed)}
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
      <div class="panel-title">
        <div>
          <h2>Leads recentes</h2>
          ${operationStartAt ? `<small>Operação iniciada em ${esc(new Date(operationStartAt).toLocaleString('pt-BR'))}. Leads anteriores permanecem armazenados.</small>` : ''}
        </div>
        <span>${leads.length} exibidos</span>
      </div>
      <div class="table-wrap"><table class="leads-table">
        <thead><tr><th>Lead</th><th>Chegada</th><th>Origem</th><th>Campanha</th><th>Etapa</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">Nenhum lead ainda.</td></tr>'}</tbody>
      </table></div>
    </section>
  `, { csrfToken });
}

export function matriculationConfirmView({ lead, csrfToken = '' }) {
  return layout('Confirmar matrícula', `
    <section class="hero">
      <div>
        <h1>Confirmar matrícula</h1>
        <p>Revise os dados antes de concluir esta etapa.</p>
      </div>
    </section>
    <section class="panel">
      <h2>${esc(lead.name)}</h2>
      <p>Curso/produto: ${esc(lead.course || '—')}</p>
      <p>
        Esta ação marcará a matrícula como concluída, ficará registrada no histórico
        e poderá enfileirar o evento Converted para a Meta quando houver atribuição.
      </p>
      <div class="actions">
        <form method="post" action="/leads/${esc(lead.id)}/matriculate">
          ${csrfField(csrfToken)}
          <input type="hidden" name="confirmation" value="MATRICULATION_COMPLETED">
          <button type="submit" class="success">Confirmar matrícula concluída</button>
        </form>
        <a class="small button-link" href="/">Cancelar</a>
      </div>
    </section>
  `, { csrfToken });
}

function statusClass(status) {
  if (['SENT', 'COMPLETED', 'DONE'].includes(status)) return 'matriculated';
  if (status === 'FAILED') return 'lost';
  if (status === 'RETRY') return 'contacted';
  if (['PROCESSING', 'RUNNING'].includes(status)) return 'opportunity';
  return 'new';
}

export function eventsView({ events, jobs, message = '', error = '', csrfToken = '' }) {
  const rows = events.map((event) => `
    <tr>
      <td><strong>${esc(event.event_name)}</strong><small>${event.event_id.endsWith(':test') ? 'TESTE' : 'PRODUÇÃO'} · ${esc(event.event_id)}</small></td>
      <td>${esc(event.lead_name)}<small>${esc(event.meta_lead_id || 'sem lead_id')}</small></td>
      <td><span class="badge ${statusClass(event.status)}">${esc(event.status)}</span><small>${esc(event.attempts)} tentativa(s)</small></td>
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
        <span class="badge ${statusClass(job.status)}">${esc(job.status)}</span>
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
      <td><span class="badge ${statusClass(instance.status)}">${detailValue(instance.status)}</span></td>
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
      const suggestion = labels.find((label) => label.name === expectedName) || null;
      const selectedLabelId = binding?.remote_label_id || suggestion?.id || '';
      const labelOptions = labels.map((label) => `
        <option value="${esc(label.id)}"${selectedLabelId === label.id ? ' selected' : ''}>
          ${esc(label.name)} · ${esc(label.id)}
        </option>`).join('');
      return `
        <tr>
          <td><strong>${esc(stage)}</strong><small>${esc(expectedName)}</small></td>
          <td>
            ${binding
              ? `${detailValue(binding.remote_label_name)}<small>${esc(binding.remote_label_id)}</small>`
              : '<span class="muted">Não configurado</span>'}
          </td>
          <td>
            ${binding
              ? `<span class="badge ${binding.enabled ? 'matriculated' : 'new'}">${binding.enabled ? 'ATIVO' : 'DESABILITADO'}</span>
                 <small>Verificado: ${detailValue(binding.last_verified_at)}</small>`
              : suggestion
                ? '<span class="ok">Correspondência exata sugerida</span>'
                : '<span class="error-text">Sem correspondência exata</span>'}
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
        <div class="panel-title"><h2>Bindings oficiais</h2><span>${bindings.length} salvos</span></div>
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
  const rows = jobs.map((job) => `
    <tr>
      <td><strong>${esc(job.lead_name)}</strong><small>${esc(job.id)}</small></td>
      <td>${detailValue(job.target_stage)}<small>${detailValue(job.target_remote_label_id)}</small></td>
      <td>${detailValue(job.instance_name || job.remote_instance_id)}<small>${detailValue(job.created_at)}</small></td>
      <td>
        <span class="badge ${statusClass(job.status)}">${esc(job.status)}</span>
        ${job.stale ? '<small class="error-text">RUNNING abandonado</small>' : ''}
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
      ${stat('PENDING', counts.pending || 0)}
      ${stat('RUNNING', counts.running || 0)}
      ${stat('DONE', counts.done || 0)}
      ${stat('FAILED', counts.failed || 0)}
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
      <span class="badge ${statusClass(status.status)}">${detailValue(status.status)}</span>
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
