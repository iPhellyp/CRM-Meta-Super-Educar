import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('motor WhatsApp do corte é privado e usa os dados/volumes existentes', async () => {
  const stack = await read('docker-stack-whatsapp-engine.yml');
  assert.match(stack, /image: wa-sender-simple:\$\{WA2_APP_IMAGE_TAG:\?WA2_APP_IMAGE_TAG obrigatoria\}/);
  assert.match(stack, /image: wa-sender-simple:\$\{WA2_WORKER_IMAGE_TAG:\?WA2_WORKER_IMAGE_TAG obrigatoria\}/);
  assert.match(stack, /DATABASE_URL: \$\{CRM_DATABASE_URL:\?CRM_DATABASE_URL obrigatoria\}/g);
  assert.match(stack, /name: crm-meta_internal/);
  assert.match(stack, /name: wa-sender-simple_baileys_session/);
  assert.match(stack, /name: wa-sender-simple_uploads/);
  assert.match(stack, /name: wa-sender-simple_redis_data/);
  assert.doesNotMatch(stack, /traefik|iPHnet|ports:/i);
  assert.doesNotMatch(stack, /postgres:/);
  assert.equal((stack.match(/replicas: 1/g) || []).length, 3);
});
