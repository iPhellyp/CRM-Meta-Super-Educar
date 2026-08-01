import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('listHistoricalOperations não referencia variável externa inexistente', async () => {
  const source = await readFile(
    new URL('../src/db.js', import.meta.url),
    'utf8',
  );

  const start = source.indexOf(
    'export async function listHistoricalOperations()',
  );
  const end = source.indexOf(
    '\nexport async function',
    start + 1,
  );
  const block = source.slice(
    start,
    end > start ? end : source.length,
  );

  assert.ok(start >= 0);
  assert.doesNotMatch(
    block,
    /readyLocalInstanceIds/,
  );
  assert.match(
    block,
    /FROM lead_file_imports[\s\S]*?\[tenantId\(\)\]/,
  );
});