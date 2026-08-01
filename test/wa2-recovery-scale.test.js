import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wa2LabelIdempotencyKey } from '../src/wa2-label-sync.js';

test('retry usa chave idempotente nova por tentativa', () => {
  const first = wa2LabelIdempotencyKey(
    'job-1',
    'apply',
    '57',
    1,
  );
  const second = wa2LabelIdempotencyKey(
    'job-1',
    'apply',
    '57',
    2,
  );

  assert.notEqual(first, second);
});

test('cliente aceita pelo menos dez mil telefones no rebuild', async () => {
  const source = await readFile(
    new URL('../src/wa2.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /phones\.length > 50_000/,
  );
});

test('worker reconstrói identidades antes de repetir LID_UNRESOLVED', async () => {
  const source = await readFile(
    new URL('../src/worker.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /refreshIdentitiesForWa2LabelJob/,
  );
  assert.match(
    source,
    /Rebuild de identidades solicitado após LID_UNRESOLVED/,
  );
  assert.match(
    source,
    /listWa2ReconciliationCandidatePhones/,
  );
});

test('layout premium mantém ação WhatsApp', async () => {
  const [view, css, serviceWorker] = await Promise.all([
    readFile(
      new URL('../src/views.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../public/app.css', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../public/service-worker.js', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(view, /Abrir no WhatsApp/);
  assert.match(view, /\/app\.css\?v=12/);
  assert.match(view, /class="nav-group"/);
  assert.match(css, /--wa-green/);
  assert.match(serviceWorker, /\$\{CACHE_PREFIX\}v12/);
});
