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

test('reconciliação comunica progresso, datas de São Paulo e retry como fila', () => {
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
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="3"/);
  assert.match(html, /29\/07\/2026 às 07:31/);
  assert.match(html, /Enfileirar falhas/);
  assert.match(html, /data-confirm="Enfileirar novamente somente as falhas elegíveis/);
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
