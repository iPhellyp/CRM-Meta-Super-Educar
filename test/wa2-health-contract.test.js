import test from 'node:test';
import assert from 'node:assert/strict';
import { createWa2Client } from '../src/wa2.js';

function clientFor(payload) {
  return createWa2Client({
    env: {
      NODE_ENV: 'test',
      WA2_INTERNAL_API_BASE_URL: 'http://localhost:3000',
      WA2_INTERNAL_API_SECRET: 'test-secret',
      WA2_INTERNAL_API_TIMEOUT_MS: '5000',
    },
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    fetchImpl: async () => new Response(
      JSON.stringify(payload),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    ),
  });
}

test('health WA2 aceita o contrato status=healthy sem campo ok', async () => {
  const health = await clientFor({
    status: 'healthy',
    application: 'healthy',
    database: 'healthy',
    redis: 'healthy',
    worker: 'unknown',
  }).getHealth();

  assert.equal(health.ok, true);
  assert.equal(health.status, 'healthy');
});

test('health WA2 não considera status unavailable como disponível', async () => {
  const health = await clientFor({
    status: 'unavailable',
    application: 'healthy',
    database: 'unavailable',
    redis: 'healthy',
  }).getHealth();

  assert.equal(health.ok, false);
  assert.equal(health.status, 'unavailable');
});

test('campo ok explícito continua tendo precedência', async () => {
  const health = await clientFor({
    ok: false,
    status: 'healthy',
  }).getHealth();

  assert.equal(health.ok, false);
});