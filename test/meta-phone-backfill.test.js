import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

const { importLeadPayload } = await import('../src/meta.js');

test('importa WhatsApp personalizado da Meta como telefone', async () => {
  let captured = null;

  const result = await importLeadPayload(
    {
      id: '1634831654669330',
      form_id: '1760211795329890',
      field_data: [
        {
          name: 'Nome',
          values: ['Lead de teste'],
        },
        {
          name: 'WhatsApp',
          values: ['+55 38 99114-2298'],
        },
      ],
    },
    {
      page_id: '1119504964569694',
      form_id: '1760211795329890',
    },
    null,
    'super-educar',
    {
      upsert: async (input) => {
        captured = input;
        return input;
      },
    },
  );

  assert.equal(result, captured);
  assert.equal(captured.name, 'Lead de teste');
  assert.equal(captured.phone, '+55 38 99114-2298');
  assert.equal(captured.metaLeadId, '1634831654669330');
  assert.equal(captured.metaFormId, '1760211795329890');
});

test('reconciliação diária ignora leads totalmente sem telefone', async () => {
  const database = await readFile(
    new URL('../src/db.js', import.meta.url),
    'utf8',
  );

  const start = database.indexOf(
    'export async function enqueueDailyWa2Reconciliations',
  );

  const end = database.indexOf(
    'export async function claimWa2ReconciliationItem',
    start,
  );

  assert.ok(start >= 0);
  assert.ok(end > start);

  const source = database.slice(start, end);

  for (const candidate of [
    'lead.phone_normalized',
    'lead.whatsapp_normalized',
    'lead.phone',
    'lead.whatsapp',
    'lead.remote_jid',
  ]) {
    assert.ok(
      source.includes(candidate),
      `Campo ausente no filtro diário: ${candidate}`,
    );
  }

  assert.doesNotMatch(
    source,
    /SELECT tenant_id, \$2, id FROM leads WHERE tenant_id = \$1/,
  );
});
