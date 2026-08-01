import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('agenda diária não repete preparo pesado quando já existe reconciliação hoje', async () => {
  const [worker, db] = await Promise.all([
    readFile(new URL('../src/worker.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/db.js', import.meta.url), 'utf8'),
  ]);

  assert.match(
    worker,
    /hasWa2ReconciliationRunToday/,
  );

  const schedulerStart = worker.indexOf(
    'async function scheduleDailyReconciliationIfNeeded()',
  );
  const schedulerEnd = worker.indexOf(
    '\nasync function run()',
    schedulerStart,
  );
  const scheduler = worker.slice(
    schedulerStart,
    schedulerEnd,
  );

  const guardIndex = scheduler.indexOf(
    'await hasWa2ReconciliationRunToday()',
  );
  const prepareIndex = scheduler.indexOf(
    'await prepareWa2Reconciliation',
  );

  assert.ok(guardIndex >= 0);
  assert.ok(prepareIndex >= 0);
  assert.ok(guardIndex < prepareIndex);

  assert.match(
    db,
    /FROM wa2_reconciliation_runs[\s\S]*America\/Sao_Paulo/,
  );
});