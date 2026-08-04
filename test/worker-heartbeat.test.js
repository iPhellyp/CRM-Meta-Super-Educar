import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkerHeartbeatLoop } from '../src/worker-heartbeat.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('worker usa um único loop de heartbeat independente do scheduler', async () => {
  const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');

  assert.match(source, /heartbeatLoop = createWorkerHeartbeatLoop/);
  assert.match(source, /heartbeatLoop\?\.stop\(\)/);
  assert.doesNotMatch(source, /await heartbeatIfNeeded\(\)/);
});

test('heartbeat continua enquanto outra rotina aguarda uma operação longa', async () => {
  let calls = 0;
  const loop = createWorkerHeartbeatLoop({
    intervalMs: 5,
    record: async () => {
      calls += 1;
      await delay(1);
    },
  });

  const longTask = delay(50);
  await longTask;
  loop.stop();

  assert.ok(calls >= 2);
});

test('heartbeat não cria chamadas sobrepostas', async () => {
  let active = 0;
  let maxActive = 0;
  const loop = createWorkerHeartbeatLoop({
    intervalMs: 5,
    record: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active -= 1;
    },
  });

  await delay(45);
  loop.stop();
  await delay(25);

  assert.equal(maxActive, 1);
});

test('erro do heartbeat não interrompe o loop', async () => {
  let calls = 0;
  const errors = [];
  const loop = createWorkerHeartbeatLoop({
    intervalMs: 5,
    record: async () => {
      calls += 1;
      throw new Error('db');
    },
    onError: (error) => errors.push(error.message),
  });

  await delay(30);
  loop.stop();

  assert.ok(calls >= 2);
  assert.equal(errors.length, calls);
});

test('stop encerra o timer e é idempotente', () => {
  const timers = [];
  const cleared = [];
  const loop = createWorkerHeartbeatLoop({
    intervalMs: 10,
    record: async () => {},
    setIntervalImpl: (callback, interval) => {
      const timer = { callback, interval };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
  });

  loop.stop();
  loop.stop();

  assert.equal(timers.length, 1);
  assert.deepEqual(cleared, timers);
});
