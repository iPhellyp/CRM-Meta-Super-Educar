import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  eventsView,
  historicalOperationsView,
  wa2LabelJobsView,
  wa2QrView,
  chatView,
  whatsappLabelsView,
  whatsappLabelContactsView,
} from '../src/views.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');

function operations(overrides = {}) {
  return {
    cursor: null,
    imports: [],
    fileImports: [],
    reconciliations: [],
    conflicts: [],
    confirmations: [],
    ...overrides,
  };
}

test('importação Meta usa checklist acessível e orienta o estado vazio', () => {
  const empty = historicalOperationsView({
    operations: operations(),
    instances: [],
    metaForms: [],
    csrfToken: 'csrf',
  });
  assert.match(empty, /Nenhum formulário disponível/);
  assert.match(empty, /href="\/meta\/connections"/);
  assert.doesNotMatch(empty, /<select name="formRecordIds"/);

  const ready = historicalOperationsView({
    operations: operations(),
    instances: [],
    metaForms: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: '<Formulário>',
      connection_name: 'Conta',
      page_name: 'Página',
    }],
    csrfToken: 'csrf',
  });
  assert.match(ready, /<fieldset class="selection-list">/);
  assert.match(ready, /name="formRecordIds"/);
  assert.match(ready, /data-required-selection/);
  assert.match(ready, /role="status"/);
  assert.doesNotMatch(ready, /<Formulário>/);
});

test('reconciliação não aparece na interface operacional', () => {
  const html = historicalOperationsView({
    operations: operations({
      reconciliations: [{
        id: '22222222-2222-4222-8222-222222222222',
        instance_name: 'Equipe',
        status: 'FAILED',
        processed_count: 3,
        total_count: 10,
        retry_count: 1,
        created_at: '2026-07-29T10:31:00.000Z',
        started_at: '2026-07-29T10:30:00.000Z',
        completed_at: '2026-07-29T10:31:00.000Z',
        results: { ERROR: 2 },
      }],
    }),
    instances: [],
    csrfToken: 'csrf',
  });
  assert.doesNotMatch(html, /Reconciliação WA2/);
  assert.doesNotMatch(html, /Iniciar reconciliação/);
  assert.doesNotMatch(html, /\/operations\/reconciliations/);
});

test('CRM concentra conversas e etiquetas WhatsApp, mantendo reconciliação fora do menu', () => {
  const source = read('src/views.js');
  const server = read('src/server.js');
  assert.match(source, /href="\/chat">Conversas<\/a>/);
  assert.doesNotMatch(source, /href="\/operations#reconciliacoes"/);
  assert.match(server, /app\.get\('\/chat', renderChatPage\)/);
  assert.match(server, /app\.post\('\/operations\/reconciliations',[\s\S]*?WA2_RECONCILIATION_DISABLED/);
  assert.doesNotMatch(server, /CHAT_DISABLED/);
  const html = chatView({
    instances: [],
    selectedInstanceId: '11111111-1111-4111-8111-111111111111',
    selectedChat: {
      id: 'chat-1',
      jid: '5511999999999@s.whatsapp.net',
      name: 'Contato',
      messageCount: 1,
      labels: [{ id: 'label-1', name: 'Interessado' }],
    },
    labels: [{ id: 'label-1', name: 'Interessado' }],
    csrfToken: 'csrf',
  });
  assert.match(html, /Conversas WhatsApp/);
  assert.match(html, /Alterar etiqueta/);
});

test('CRM exibe o catálogo real de etiquetas e seus contatos', () => {
  const labels = whatsappLabelsView({
    instance: { id: 'instance-1', name: 'WhatsApp principal' },
    labels: [{ id: '10', name: 'Novo', chatCount: 4 }],
  });
  const contacts = whatsappLabelContactsView({
    instance: { id: 'instance-1', name: 'WhatsApp principal' },
    label: { id: '10', name: 'Novo', chatCount: 4 },
    chats: [{ id: 'chat-1', displayName: 'Ana', displayPhone: '+55 (11) 98765-4321', jid: '5511987654321@s.whatsapp.net', lastMessageText: 'Olá', lastMessageAt: '2026-08-01T12:00:00.000Z' }],
  });
  assert.match(labels, /href="\/etiquetas\/10/);
  assert.match(labels, /4 contato/);
  assert.match(contacts, /Ana/);
  assert.match(contacts, /\+55 \(11\) 98765-4321/);
});

test('eventos e jobs têm status textual, cards mobile e erro escapado', () => {
  const html = eventsView({
    events: [],
    jobs: [{
      id: 'job-1',
      job_type: 'LEAD_IMPORT',
      lead_name: 'Lead',
      status: 'FAILED',
      attempts: 3,
      created_at: '2026-07-29T10:31:00.000Z',
      last_error: '<falha>',
    }],
    csrfToken: 'csrf',
  });
  assert.match(html, /mobile-admin-only/);
  assert.match(html, />Falhou</);
  assert.match(html, /Enfileirar novamente/);
  assert.match(html, /&lt;falha&gt;/);
  assert.doesNotMatch(html, /<falha>/);
});

test('job WA2 só oferece retry para falha elegível', () => {
  const html = wa2LabelJobsView({
    jobs: [{
      id: 'job-failed',
      lead_name: 'Lead',
      status: 'FAILED',
      attempts: 2,
      max_attempts: 5,
    }, {
      id: 'job-running',
      lead_name: 'Lead 2',
      status: 'RUNNING',
      attempts: 1,
      max_attempts: 5,
    }],
    csrfToken: 'csrf',
  });
  assert.match(html, /\/wa2\/label-jobs\/job-failed\/retry/);
  assert.doesNotMatch(html, /\/wa2\/label-jobs\/job-running\/retry/);
});

test('QR é temporário e as duas rotas aplicam no-store', () => {
  const html = wa2QrView({
    instanceId: 'remote-1',
    status: { status: 'QR_REQUIRED', requiresQr: true },
    csrfToken: 'csrf',
  });
  const server = read('src/server.js');
  assert.match(html, /QR pode expirar/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(server, /app\.get\('\/wa2\/instances\/:id\/qr'[\s\S]*?noStore\(res\)/);
  assert.match(server, /app\.get\('\/wa2\/instances\/:id\/qr\/image'[\s\S]*?noStore\(res\)/);
});

test('CSS troca tabelas administrativas por cards no celular', () => {
  const css = read('public/app.css');
  assert.match(css, /\.mobile-admin-only \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.mobile-admin-only \{ display: grid; \}/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.desktop-admin-only \{ display: none; \}/);
});
