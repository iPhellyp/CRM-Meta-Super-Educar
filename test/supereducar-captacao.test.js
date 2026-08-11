import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapSupereducarCaptacaoRecord,
  syncSupereducarCaptacao,
  supereducarCaptacaoConfig,
} from '../src/supereducar-captacao.js';

const CONFIG = {
  url: 'https://supereducar.com/api/captacao-interesse',
  token: 'super-secret-test-token',
  intervalMs: 300_000,
  startAfterId: '113',
  enabled: true,
};

const ROWS = [
  {
    id: 114,
    opcao: 'Medicina Veterinária',
    celular: '(38) 98851-5846',
    data: '2026-08-11 10:41:37',
  },
  {
    id: 115,
    opcao: 'Cursos Livres',
    celular: '+55 38 99999-1111',
    data: '2026-08-11 10:42:00',
  },
];

function response(body, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return raw;
    },
  };
}

function fetchWith(body, status = 200) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(body, status);
    },
  };
}

function validBody(rows = ROWS) {
  return { status: 'ok', total: rows.length, dados: rows };
}

test('configuração é opt-in e não habilita sem token', () => {
  assert.equal(supereducarCaptacaoConfig({}).enabled, false);
  assert.equal(supereducarCaptacaoConfig({
    SUPEREDUCAR_CAPTACAO_API_TOKEN: 'token',
  }).enabled, false);
  assert.equal(supereducarCaptacaoConfig({
    SUPEREDUCAR_CAPTACAO_API_TOKEN: 'token',
    SUPEREDUCAR_CAPTACAO_START_AFTER_ID: '',
  }).enabled, false);
  const configured = supereducarCaptacaoConfig({
    SUPEREDUCAR_CAPTACAO_API_TOKEN: 'token',
    SUPEREDUCAR_CAPTACAO_START_AFTER_ID: '113',
  });
  assert.equal(configured.startAfterId, '113');
  assert.equal(configured.enabled, true);
  assert.equal(supereducarCaptacaoConfig({
    SUPEREDUCAR_CAPTACAO_API_URL: 'http://insecure.example.test',
    SUPEREDUCAR_CAPTACAO_API_TOKEN: 'token',
  }).enabled, false);
});

test('duas respostas novas criam dois payloads WEBSITE_FORM/NEW', async () => {
  const fixture = fetchWith(validBody([
    { ...ROWS[0], id: 112 },
    ...ROWS,
  ]));
  const payloads = [];
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async (payload) => {
      payloads.push(payload);
      return { created: true, code: 'CREATED' };
    },
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.ignoredBeforeCutoff, 1);
  assert.equal(result.created, 2);
  assert.equal(result.replayed, 0);
  assert.equal(payloads[0].external_lead_id, 'supereducar-site-114');
  assert.equal(payloads[0].source, 'WEBSITE_FORM');
  assert.equal(payloads[0].stage, 'NEW');
  assert.equal(payloads[0].interest, 'Medicina Veterinária');
  assert.equal(payloads[0].submitted_at, '2026-08-11T13:41:37.000Z');
  assert.equal(fixture.calls[0].options.headers['X-Api-Token'], CONFIG.token);
});

test('segunda sincronização dos mesmos IDs é idempotente', async () => {
  const fixture = fetchWith(validBody());
  const stored = new Set();
  const ingest = async (payload) => {
    if (stored.has(payload.external_lead_id)) {
      return { created: false, code: 'IDEMPOTENT_REPLAY' };
    }
    stored.add(payload.external_lead_id);
    return { created: true, code: 'CREATED' };
  };

  const first = await syncSupereducarCaptacao({ config: CONFIG, fetchImpl: fixture.fetchImpl, ingest });
  const second = await syncSupereducarCaptacao({ config: CONFIG, fetchImpl: fixture.fetchImpl, ingest });
  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.equal(second.replayed, 2);
});

test('um lead novo e um existente são separados', async () => {
  const fixture = fetchWith(validBody());
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async (payload) => payload.external_lead_id === 'supereducar-site-114'
      ? { created: false, code: 'IDEMPOTENT_REPLAY' }
      : { created: true, code: 'CREATED' },
  });
  assert.equal(result.created, 1);
  assert.equal(result.replayed, 1);
});

test('telefone formatado é aceito e telefone inválido é ignorado', async () => {
  const mapped = mapSupereducarCaptacaoRecord(ROWS[0]);
  assert.equal(mapped.phone, '(38) 98851-5846');
  const fixture = fetchWith(validBody([
    ROWS[0],
    { ...ROWS[1], id: 116, celular: '123' },
  ]));
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async () => ({ created: true, code: 'CREATED' }),
  });
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.INVALID_RECORD, 1);
});

test('opcao vazia não derruba o lote', async () => {
  const fixture = fetchWith(validBody([
    { ...ROWS[0], opcao: '' },
    ROWS[1],
  ]));
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async () => ({ created: true, code: 'CREATED' }),
  });
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 1);
});

test('respostas 401, 429 e 500 são classificadas sem expor o token', async () => {
  for (const [status, code, transient] of [
    [401, 'AUTHENTICATION_ERROR', false],
    [429, 'RATE_LIMIT', true],
    [500, 'REMOTE_5XX', true],
  ]) {
    const fixture = fetchWith({ error: 'ignored' }, status);
    const result = await syncSupereducarCaptacao({
      config: CONFIG,
      fetchImpl: fixture.fetchImpl,
      ingest: async () => ({ created: true }),
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, code);
    assert.equal(result.transient, transient);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-test-token/);
  }
});

test('timeout é classificado como transitório', async () => {
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    },
    ingest: async () => ({ created: true }),
  });
  assert.equal(result.code, 'TIMEOUT');
  assert.equal(result.transient, true);
});

test('JSON inválido é rejeitado sem usar o corpo nos logs ou resultado', async () => {
  const fixture = fetchWith('not-json');
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async () => ({ created: true }),
  });
  assert.equal(result.code, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(result), /not-json/);
});

test('registro inválido não impede os demais do lote', async () => {
  const fixture = fetchWith(validBody([
    ROWS[0],
    null,
    { ...ROWS[1], id: 117, data: 'invalid-date' },
    { ...ROWS[1], id: 118 },
  ]));
  const accepted = [];
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async (payload) => {
      accepted.push(payload.external_lead_id);
      return { created: true, code: 'CREATED' };
    },
  });
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(accepted, ['supereducar-site-114', 'supereducar-site-118']);
});

test('configuração, external id, source e stage não carregam o token para o resultado', async () => {
  const fixture = fetchWith(validBody([ROWS[0]]));
  const result = await syncSupereducarCaptacao({
    config: CONFIG,
    fetchImpl: fixture.fetchImpl,
    ingest: async (payload) => {
      assert.equal(payload.external_lead_id, 'supereducar-site-114');
      assert.equal(payload.source, 'WEBSITE_FORM');
      assert.equal(payload.stage, 'NEW');
      return { created: true, code: 'CREATED' };
    },
  });
  assert.equal(result.created, 1);
  assert.doesNotMatch(JSON.stringify(result), /super-secret-test-token/);
});
