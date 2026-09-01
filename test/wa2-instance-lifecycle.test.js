import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('cliente CRM cria e exclui instâncias remotas', async () => {
  const client = await read('src/wa2.js');
  assert.match(client, /createInstance: \(name, role\)/);
  assert.match(client, /deleteInstance: \(instanceId\)/);
  assert.match(client, /export const createWa2Instance/);
  assert.match(client, /export const deleteWa2Instance/);
});

test('dashboard espelha WA2 e desativa registros remotos ausentes', async () => {
  const [server, database] = await Promise.all([
    read('src/server.js'),
    read('src/db.js'),
  ]);
  assert.match(server, /disableMissingWa2Instances\(instances\.map/);
  assert.match(database, /remote_status = 'REMOTE_DELETED'/);
  assert.match(server, /app\.post\('\/wa2\/instances\/create'/);
  assert.match(server, /app\.post\('\/wa2\/instances\/:id\/delete'/);
});

test('CRM exibe o QR remoto e atualiza enquanto conecta', async () => {
  const [views, browser] = await Promise.all([
    read('src/views.js'),
    read('public/app.js'),
  ]);
  assert.match(views, /\/qr\/image/);
  assert.match(views, /data-auto-refresh-ms/);
  assert.match(browser, /data-auto-refresh-ms/);
  assert.match(views, /Excluir instância/);
});

test('CRM oferece pairing code e reset explícito da sessão', async () => {
  const [views, server, client] = await Promise.all([
    read('src/views.js'),
    read('src/server.js'),
    read('src/wa2.js'),
  ]);
  assert.match(views, /pairing-code/);
  assert.match(views, /RESET_WA2_SESSION/);
  assert.match(server, /app\.post\('\/wa2\/instances\/:id\/pairing-code'/);
  assert.match(server, /app\.post\('\/wa2\/instances\/:id\/reset'/);
  assert.match(client, /requestWa2PairingCode/);
  assert.match(client, /resetWa2Instance/);
});
