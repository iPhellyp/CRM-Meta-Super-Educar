import {
  STAGE_LABELS,
  STAGES,
  getStageActions,
  getStageBadgeClass,
} from './funnel.js';
import { getWhatsAppUrl } from './phone.js';

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
  ${logged ? `<header><strong>CRM Meta · Super Educar</strong><nav><a href="/">Leads</a><a href="/events">Eventos Meta</a><form method="post" action="/logout">${csrfField(csrfToken)}<button class="link">Sair</button></form></nav></header>` : ''}
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
  if (['SENT', 'COMPLETED'].includes(status)) return 'matriculated';
  if (status === 'FAILED') return 'lost';
  if (status === 'RETRY') return 'contacted';
  if (status === 'PROCESSING') return 'opportunity';
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
