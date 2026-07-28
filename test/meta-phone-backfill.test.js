import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeBrazilianPhone } from '../src/phone.js';

process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

const {
  importLeadPayload,
  normalizeMetaFieldName,
} = await import('../src/meta.js');
const {
  processMetaPhoneCandidates,
} = await import('../scripts/backfill-meta-phones.js');

test('normaliza nomes reais de campos Meta', () => {
  assert.equal(normalizeMetaFieldName('Número do WhatsApp'), 'numero_do_whatsapp');
  assert.equal(normalizeMetaFieldName('número_do_whatsapp'), 'numero_do_whatsapp');
  assert.equal(normalizeMetaFieldName('Telefone / Celular'), 'telefone_celular');
});

const acceptedPhoneFieldNames = [
  'phone_number',
  'telefone',
  'phone',
  'celular',
  'whatsapp',
  'número_do_whatsapp',
  'Número do WhatsApp',
  'numero_do_whatsapp',
  'numero_de_whatsapp',
  'telefone_whatsapp',
  'whatsapp_number',
  'numero_do_celular',
];

for (const fieldName of acceptedPhoneFieldNames) {
  test(`importa ${fieldName} como telefone sem alterar o valor original`, async () => {
    let captured = null;
    const originalPhone = '+55 38 99905-9949';

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
            name: fieldName,
            values: [originalPhone],
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
          captured = {
            ...input,
            phoneNormalized: normalizeBrazilianPhone(input.phone),
          };
          return captured;
        },
      },
    );

    assert.equal(result, captured);
    assert.equal(captured.name, 'Lead de teste');
    assert.equal(captured.phone, originalPhone);
    assert.equal(captured.phoneNormalized, '5538999059949');
    assert.equal(captured.metaLeadId, '1634831654669330');
    assert.equal(captured.metaFormId, '1760211795329890');
  });
}

test('backfill é limitado, tenant-safe, reutiliza importação e não roda automaticamente', async () => {
  const script = await readFile(
    new URL('../scripts/backfill-meta-phones.js', import.meta.url),
    'utf8',
  );
  assert.match(script, /const MAX_INITIAL_LIMIT = 10/);
  assert.match(script, /Informe --limit com um inteiro entre 1 e 10/);
  assert.match(script, /--dry-run/);
  assert.match(script, /--apply/);
  assert.match(script, /--tenant deve corresponder exatamente a DEFAULT_TENANT_ID/);
  assert.match(script, /lead\.tenant_id = \$1/);
  assert.match(script, /lead\.source = 'META_INSTANT_FORM'/);
  assert.match(script, /lead\.meta_lead_id IS NOT NULL/);
  assert.match(script, /lead\.phone_normalized IS NULL/);
  assert.match(script, /importLeadgenId/);
  assert.match(script, /upsert: async \(input\) =>/);
  assert.match(script, /persistLead: upsertLead/);
  assert.match(script, /token da conexão e fallback legado indisponíveis/);
  assert.match(script, /Backfill Meta interrompido sem expor detalhes sensíveis/);
  assert.equal(
    script.match(/console\.log\(JSON\.stringify\(summary\)\)/g)?.length,
    1,
  );
  assert.doesNotMatch(script, /console\.(log|error)\([^)]*accessToken/);
  assert.doesNotMatch(script, /DELETE|TRUNCATE|UPDATE\s+leads/i);
});

test('Dockerfile inclui somente o script autorizado de backfill Meta', async () => {
  const dockerfile = await readFile(
    new URL('../Dockerfile', import.meta.url),
    'utf8',
  );
  const copyInstructions = dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^COPY\s+/i.test(line));

  assert.ok(copyInstructions.includes(
    'COPY --chown=node:node scripts/backfill-meta-phones.js ./scripts/backfill-meta-phones.js',
  ));

  const copiedScriptSources = copyInstructions.flatMap((instruction) => {
    const body = instruction
      .replace(/^COPY\s+/i, '')
      .replace(/^(?:--\S+\s+)*/, '');
    const paths = body.startsWith('[')
      ? JSON.parse(body)
      : body.split(/\s+/);
    return paths.slice(0, -1).filter((source) => (
      source.replace(/^\.\//, '').startsWith('scripts')
    ));
  });

  assert.deepEqual(copiedScriptSources, [
    'scripts/backfill-meta-phones.js',
  ]);
  assert.equal(copiedScriptSources.some((source) => (
    /^\.?\/?scripts\/?$/.test(source)
  )), false);
});

async function withLegacyMetaToken(callback) {
  const previousLegacyToken = process.env.META_PAGE_ACCESS_TOKEN;
  process.env.META_PAGE_ACCESS_TOKEN = 'token-de-teste-nao-impresso';
  try {
    return await callback();
  } finally {
    if (previousLegacyToken === undefined) {
      delete process.env.META_PAGE_ACCESS_TOKEN;
    } else {
      process.env.META_PAGE_ACCESS_TOKEN = previousLegacyToken;
    }
  }
}

function legacyCandidate(metaLeadId) {
  return {
    meta_lead_id: metaLeadId,
    meta_connection_id: null,
  };
}

test('apply não persiste telefone inválido', async () => {
  await withLegacyMetaToken(async () => {
    let persistCalls = 0;
    let controlledUpsertCalls = 0;

    const summary = await processMetaPhoneCandidates(
      [legacyCandidate('4000000000000001')],
      {
        dryRun: false,
        tenant: 'super-educar',
        limit: 1,
        importLeadgenId: async (
          _metaLeadId,
          _webhookValue,
          _receivedAt,
          _tenant,
          options,
        ) => {
          controlledUpsertCalls += 1;
          return options.upsert({ phone: '123' });
        },
        persistLead: async (input) => {
          persistCalls += 1;
          return input;
        },
      },
    );

    assert.equal(controlledUpsertCalls, 1);
    assert.equal(persistCalls, 0);
    assert.equal(summary.missingPhoneCount, 1);
    assert.deepEqual(summary.missingPhoneMetaLeadIds, ['4000000000000001']);
    assert.equal(summary.updatedCount, 0);
    assert.deepEqual(summary.updatedMetaLeadIds, []);
  });
});

test('apply persiste telefone válido exatamente uma vez', async () => {
  await withLegacyMetaToken(async () => {
    const persistedIds = [];

    const summary = await processMetaPhoneCandidates(
      [legacyCandidate('4000000000000002')],
      {
        dryRun: false,
        tenant: 'super-educar',
        limit: 1,
        importLeadgenId: async (
          metaLeadId,
          _webhookValue,
          _receivedAt,
          _tenant,
          options,
        ) => options.upsert({
          metaLeadId,
          phone: '+55 38 99905-9949',
        }),
        persistLead: async (input) => {
          persistedIds.push(input.metaLeadId);
          return input;
        },
      },
    );

    assert.deepEqual(persistedIds, ['4000000000000002']);
    assert.equal(summary.phoneFoundCount, 1);
    assert.equal(summary.updatedCount, 1);
    assert.deepEqual(summary.updatedMetaLeadIds, ['4000000000000002']);
  });
});

test('dry-run com telefone válido nunca chama persistência', async () => {
  await withLegacyMetaToken(async () => {
    let persistCalls = 0;

    const summary = await processMetaPhoneCandidates(
      [legacyCandidate('4000000000000003')],
      {
        dryRun: true,
        tenant: 'super-educar',
        limit: 1,
        importLeadgenId: async (
          metaLeadId,
          _webhookValue,
          _receivedAt,
          _tenant,
          options,
        ) => options.upsert({
          metaLeadId,
          phone: '+55 38 99905-9949',
        }),
        persistLead: async (input) => {
          persistCalls += 1;
          return input;
        },
      },
    );

    assert.equal(persistCalls, 0);
    assert.equal(summary.phoneFoundCount, 1);
    assert.equal(summary.updatedCount, 0);
    assert.deepEqual(summary.updatedMetaLeadIds, []);
  });
});

test('lote misto persiste somente o telefone válido', async () => {
  await withLegacyMetaToken(async () => {
    const invalidId = '4000000000000004';
    const validId = '4000000000000005';
    const failedId = '4000000000000006';
    const persistedIds = [];

    const summary = await processMetaPhoneCandidates(
      [
        legacyCandidate(invalidId),
        legacyCandidate(validId),
        legacyCandidate(failedId),
      ],
      {
        dryRun: false,
        tenant: 'super-educar',
        limit: 3,
        importLeadgenId: async (
          metaLeadId,
          _webhookValue,
          _receivedAt,
          _tenant,
          options,
        ) => {
          if (metaLeadId === failedId) throw new Error('graph failure');
          return options.upsert({
            metaLeadId,
            phone: metaLeadId === validId ? '+55 38 99905-9949' : '',
          });
        },
        persistLead: async (input) => {
          persistedIds.push(input.metaLeadId);
          return input;
        },
      },
    );

    assert.deepEqual(persistedIds, [validId]);
    assert.equal(summary.selectedCount, 3);
    assert.equal(summary.phoneFoundCount, 1);
    assert.deepEqual(summary.phoneFoundMetaLeadIds, [validId]);
    assert.equal(summary.missingPhoneCount, 1);
    assert.deepEqual(summary.missingPhoneMetaLeadIds, [invalidId]);
    assert.equal(summary.failedCount, 1);
    assert.deepEqual(summary.failedMetaLeadIds, [failedId]);
    assert.equal(summary.updatedCount, 1);
    assert.deepEqual(summary.updatedMetaLeadIds, [validId]);
    assert.equal(
      summary.phoneFoundCount +
        summary.missingPhoneCount +
        summary.failedCount,
      summary.selectedCount,
    );
  });
});

test('falha de token não interrompe os demais candidatos no dry-run', async () => {
  const importedIds = [];
  let realPersistenceCalls = 0;

  await withLegacyMetaToken(async () => {
    const summary = await processMetaPhoneCandidates(
      [
        {
          meta_lead_id: '1000000000000001',
          meta_connection_id: 'connection-without-token',
          connection_active: false,
          connection_status: 'INVALID',
          encrypted_access_token: null,
        },
        {
          meta_lead_id: '1000000000000002',
          meta_connection_id: null,
          meta_page_id: '2000000000000001',
          meta_form_id: '3000000000000001',
        },
      ],
      {
        dryRun: true,
        tenant: 'super-educar',
        limit: 2,
        importLeadgenId: async (
          metaLeadId,
          _webhookValue,
          _receivedAt,
          _tenant,
          options,
        ) => {
          importedIds.push(metaLeadId);
          const persist = options.upsert || (async (input) => {
            realPersistenceCalls += 1;
            return input;
          });
          return persist({ phone: '+55 38 99905-9949' });
        },
      },
    );

    assert.deepEqual(importedIds, ['1000000000000002']);
    assert.equal(summary.failedCount, 1);
    assert.deepEqual(summary.failedMetaLeadIds, ['1000000000000001']);
    assert.equal(summary.phoneFoundCount, 1);
    assert.deepEqual(summary.phoneFoundMetaLeadIds, ['1000000000000002']);
    assert.equal(summary.updatedCount, 0);
    assert.equal(realPersistenceCalls, 0);
  });
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
