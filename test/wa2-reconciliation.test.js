import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  prepareWa2Reconciliation,
  wa2ReconciliationInstanceIds,
} from '../src/wa2-reconciliation.js';

test('reconciliação separa UUID local do ID remoto em todas as chamadas', async () => {
  const localInstanceId = '11111111-1111-4111-8111-111111111111';
  const remoteInstanceId = 'wa2-remote-instance';
  const ids = wa2ReconciliationInstanceIds({
    id: localInstanceId,
    enabled: true,
    remote_instance_id: remoteInstanceId,
  });
  const remoteCalls = [];
  await prepareWa2Reconciliation({
    ids,
    candidatePhones: ['5538999999999'],
    health: async () => ({ ok: true }),
    getStatus: async (id) => {
      remoteCalls.push(['status', id]);
      return { status: 'connected' };
    },
    connect: async (id) => remoteCalls.push(['connect', id]),
    quickSync: async (id, scope) => remoteCalls.push(['sync', id, scope]),
    rebuild: async (id) => remoteCalls.push(['rebuild', id]),
    getRebuildStatus: async (id) => {
      remoteCalls.push(['rebuild-status', id]);
      return { status: 'complete' };
    },
  });
  assert.equal(ids.localInstanceId, localInstanceId);
  assert.ok(remoteCalls.every((call) => call[1] === remoteInstanceId));
  assert.deepEqual(remoteCalls.map((call) => call[0]), [
    'status', 'sync', 'rebuild', 'rebuild-status',
  ]);
});

test('reconciliação recupera sessão antes de quick e não cria prontidão prematura', async () => {
  let statusChecks = 0;
  const calls = [];
  await prepareWa2Reconciliation({
    ids: { localInstanceId: 'local', remoteInstanceId: 'remote' },
    candidatePhones: [],
    health: async () => ({ ok: true }),
    getStatus: async () => ({ status: ++statusChecks > 1 ? 'connected' : 'disconnected' }),
    connect: async () => calls.push('connect'),
    quickSync: async () => calls.push('quick'),
    rebuild: async () => calls.push('rebuild'),
    getRebuildStatus: async () => ({ status: 'complete' }),
    wait: async () => {},
  });
  assert.deepEqual(calls, ['connect', 'quick', 'rebuild']);
});

test('instância desabilitada ou sem ID remoto é rejeitada localmente', () => {
  assert.throws(
    () => wa2ReconciliationInstanceIds({ id: 'local', enabled: false, remote_instance_id: 'remote' }),
    { code: 'WA2_INSTANCE_DISABLED' },
  );
  assert.throws(
    () => wa2ReconciliationInstanceIds({ id: 'local', enabled: true }),
    { code: 'WA2_REMOTE_INSTANCE_ID_MISSING' },
  );
});

test('rota usa ID remoto no preparo e UUID local ao criar o run', async () => {
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = source.slice(
    source.indexOf("app.post('/operations/reconciliations'"),
    source.indexOf("app.post('/operations/reconciliations/:id/retry'"),
  );
  assert.match(route, /prepareWa2Reconciliation\(\{[\s\S]*ids,/);
  assert.match(route, /createWa2Reconciliation\(\{\s*instanceId: ids\.localInstanceId/);
  assert.doesNotMatch(route, /rebuildWa2Identities\(localInstanceId/);
});

test('agenda automática filtra somente instâncias que concluíram o preparo', async () => {
  const database = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(
    database,
    /enqueueDailyWa2Reconciliations\(readyLocalInstanceIds\)[\s\S]*id = ANY\(\$2::uuid\[\]\)/,
  );
});
