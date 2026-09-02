import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('etiquetas e contatos oferecem exportação CSV paginada', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const views = await readFile(new URL('../src/views.js', import.meta.url), 'utf8');

  assert.match(server, /app\.get\('\/etiquetas\/:id\/export\.csv'/);
  assert.match(server, /listWa2Chats\(instance\.remote_instance_id/);
  assert.match(views, /export\.csv/);
});
