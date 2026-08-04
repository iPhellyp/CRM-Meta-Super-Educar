import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createWa2DailyScheduleState,
  describeWa2DailyError,
  isTransientWa2DailyError,
  isWa2DailyReconciliationEnabled,
  wa2DailyLocalDate,
} from '../src/wa2-daily-scheduler.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('timezone do scheduler usa a data BRT, inclusive na virada UTC', () => {
  assert.equal(wa2DailyLocalDate(new Date('2026-08-04T02:59:59.000Z')), '2026-08-03');
  assert.equal(wa2DailyLocalDate(new Date('2026-08-04T03:00:00.000Z')), '2026-08-04');
});

test('agendamento pode permanecer bloqueado sem executar reconciliação nesta release', () => {
  assert.equal(isWa2DailyReconciliationEnabled({ WA2_DAILY_RECONCILIATION_ENABLED: 'false' }), false);
  assert.equal(isWa2DailyReconciliationEnabled({ WA2_DAILY_RECONCILIATION_ENABLED: 'true' }), true);
  assert.equal(isWa2DailyReconciliationEnabled({}), true);
});

test('erro transitório e timeout recebem classificação e fingerprint sanitizado', () => {
  const details = describeWa2DailyError({
    name: 'Wa2Error',
    code: 'WA2_IDENTITY_REBUILD_FAILED',
    message: 'Reconstrução de identidades falhou',
    status: 504,
    remoteCode: 'DEPENDENCY_TIMEOUT',
    stack: 'segredo não deve ser impresso',
  });
  assert.equal(details.transient, true);
  assert.equal(details.status, 504);
  assert.match(details.fingerprint, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(details), /segredo/);
  assert.equal(isTransientWa2DailyError({ code: 'WA2_TIMEOUT' }), true);
  assert.equal(isTransientWa2DailyError({ code: 'WA2_HTTP_ERROR', status: 503 }), true);
  assert.equal(isTransientWa2DailyError({ code: 'WA2_HTTP_ERROR', status: 404 }), false);
  assert.equal(isTransientWa2DailyError({ code: 'WA2_CONFIG_INVALID' }), false);
});

test('duas chamadas concorrentes no mesmo worker compartilham o preparo', async () => {
  let calls = 0;
  const state = createWa2DailyScheduleState();
  const task = () => new Promise((resolve) => {
    calls += 1;
    setTimeout(resolve, 5);
  });
  const first = state.run(task);
  const second = state.run(task);
  assert.equal(first, second);
  await first;
  assert.equal(calls, 1);
});

test('falha transitória usa backoff e volta a tentar somente depois dele', async () => {
  let now = 1000;
  let calls = 0;
  const state = createWa2DailyScheduleState({ now: () => now, backoffMs: 100 });
  await assert.rejects(state.run(async () => {
    calls += 1;
    throw Object.assign(new Error('timeout'), { code: 'WA2_TIMEOUT' });
  }));
  assert.equal(state.run(async () => { calls += 1; }), null);
  now += 101;
  await state.run(async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('falha permanente não entra em loop no mesmo dia e libera no dia seguinte', async () => {
  let now = 1000;
  const dates = ['2026-08-04', '2026-08-04', '2026-08-05'];
  let dateIndex = 0;
  let calls = 0;
  const state = createWa2DailyScheduleState({
    now: () => now,
    localDate: () => dates[dateIndex],
  });
  await assert.rejects(state.run(async () => {
    calls += 1;
    throw Object.assign(new Error('configuração inválida'), { code: 'WA2_CONFIG_INVALID' });
  }));
  assert.equal(state.run(async () => { calls += 1; }), null);
  dateIndex = 2;
  now += 86_400_000;
  await state.run(async () => { calls += 1; });
  assert.equal(calls, 2);
});

test('o lock diário é durável, tenant-safe e impede dois workers concorrentes', async () => {
  const [database, worker] = await Promise.all([
    read('src/db.js'),
    read('src/worker.js'),
  ]);
  assert.match(database, /pg_try_advisory_lock\(hashtextextended/);
  assert.match(database, /pg_advisory_unlock\(hashtextextended/);
  assert.match(database, /WA2_DAILY_RECONCILIATION:\$\{tenantId\(\)\}/);
  assert.match(database, /claimDailyWa2ReconciliationDecision/);
  assert.match(database, /ON CONFLICT DO NOTHING/);
  assert.match(worker, /withWa2DailyReconciliationLock/);
});

test('não há instância/candidato elegível sem iniciar preparo pesado', async () => {
  const worker = await read('src/worker.js');
  const guard = worker.slice(
    worker.indexOf('const instances = await listWa2InstancesLocal'),
    worker.indexOf('const claimed = await claimDailyWa2ReconciliationDecision', worker.indexOf('const instances = await listWa2InstancesLocal')),
  );
  assert.match(guard, /instances\.length === 0 \|\| candidatePhones\.length === 0/);
  assert.ok(guard.indexOf('claimDailyWa2ReconciliationDecision') < 0);
  assert.ok(guard.indexOf('prepareWa2Reconciliation') < 0);
});

test('o preparo não bloqueia o loop principal nem o heartbeat', async () => {
  const worker = await read('src/worker.js');
  const loop = worker.slice(
    worker.indexOf('while (!stopping)'),
    worker.indexOf('\n}\n\nfunction stop', worker.indexOf('while (!stopping)')),
  );
  assert.doesNotMatch(loop, /scheduleDailyReconciliationIfNeeded/);
  assert.match(worker, /dailyReconciliationTimer = setInterval/);
  assert.match(worker, /dailyReconciliationTimer\.unref\(\)/);
  assert.ok(worker.indexOf('createWorkerHeartbeatLoop') < worker.indexOf('dailyReconciliationTimer = setInterval'));
});

test('a decisão diária é explícita em timezone BRT e o marcador não é duplicado', async () => {
  const database = await read('src/db.js');
  assert.match(database, /America\/Sao_Paulo/);
  assert.match(database, /scheduled_task_runs \(tenant_id, task_name, local_run_date\)/);
  assert.match(database, /claimDailyWa2ReconciliationDecision/);
  assert.match(database, /localRunDate/);
});

test('o marcador é liberado somente quando o preparo falha antes da criação do run', async () => {
  const worker = await read('src/worker.js');
  const scheduler = worker.slice(
    worker.indexOf('const claimed = await claimDailyWa2ReconciliationDecision'),
    worker.indexOf('\n  });\n  if (!task)', worker.indexOf('const claimed = await claimDailyWa2ReconciliationDecision')),
  );
  assert.match(scheduler, /releaseDailyWa2ReconciliationDecision/);
  assert.match(scheduler, /enqueueDailyWa2Reconciliations\(/);
  assert.match(scheduler, /decisionClaimed: true/);
});

test('o diagnóstico do erro não registra stack, token, payload ou telefone', async () => {
  const helper = await read('src/wa2-daily-scheduler.js');
  assert.doesNotMatch(helper, /console\.(log|error)/);
  assert.doesNotMatch(helper, /access.?token|authorization|phone|remoteJid/i);
  assert.match(helper, /fingerprint/);
});

test('a fila diária continua idempotente e sem migration nova', async () => {
  const [database, files] = await Promise.all([
    read('src/db.js'),
    read('test/wa2-reconciliation.test.js'),
  ]);
  assert.match(database, /enqueueDailyWa2Reconciliations\([\s\S]*decisionClaimed/);
  assert.match(database, /ON CONFLICT \(tenant_id, wa2_instance_id\)/);
  assert.match(files, /enqueueDailyWa2Reconciliations/);
});
