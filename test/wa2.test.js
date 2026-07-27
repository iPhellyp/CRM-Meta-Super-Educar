import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Wa2Error,
  createWa2Client,
  parseWa2Qr,
  validateWa2Config,
  wa2ConfigStatus,
} from '../src/wa2.js';
import { wa2DashboardView } from '../src/views.js';

const PLACEHOLDER_SECRET = 'placeholder-for-local-tests';
const VALID_ENV = Object.freeze({
  NODE_ENV: 'test',
  WA2_INTERNAL_API_BASE_URL: 'http://localhost:3100',
  WA2_INTERNAL_API_SECRET: PLACEHOLDER_SECRET,
  WA2_INTERNAL_API_TIMEOUT_MS: '1000',
});
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(fetchImpl, env = VALID_ENV) {
  return createWa2Client({ env, fetchImpl });
}

test('mantém a integração desativada quando URL e segredo estão ausentes', () => {
  const status = wa2ConfigStatus({ NODE_ENV: 'test', WA2_INTERNAL_API_TIMEOUT_MS: '5000' });
  assert.equal(status.state, 'disabled');
  assert.equal(status.enabled, false);
  assert.doesNotThrow(() =>
    validateWa2Config({ NODE_ENV: 'test', WA2_INTERNAL_API_TIMEOUT_MS: '5000' }));
});

test('marca configuração como inválida quando somente a URL está presente', () => {
  const status = wa2ConfigStatus({
    NODE_ENV: 'test',
    WA2_INTERNAL_API_BASE_URL: 'http://localhost:3100',
  });
  assert.equal(status.state, 'invalid');
  assert.throws(() => validateWa2Config({
    NODE_ENV: 'test',
    WA2_INTERNAL_API_BASE_URL: 'http://localhost:3100',
  }), { code: 'WA2_CONFIG_INVALID' });
});

test('marca configuração como inválida quando somente o segredo está presente', () => {
  const status = wa2ConfigStatus({
    NODE_ENV: 'test',
    WA2_INTERNAL_API_SECRET: PLACEHOLDER_SECRET,
  });
  assert.equal(status.state, 'invalid');
});

test('rejeita timeout fora dos limites', () => {
  for (const timeout of ['texto', '499', '30001', '1.5']) {
    assert.equal(wa2ConfigStatus({
      ...VALID_ENV,
      WA2_INTERNAL_API_TIMEOUT_MS: timeout,
    }).state, 'invalid');
  }
});

test('exige HTTPS em produção', () => {
  assert.equal(wa2ConfigStatus({
    ...VALID_ENV,
    NODE_ENV: 'production',
  }).state, 'invalid');
});

test('permite HTTP em localhost no ambiente de teste', () => {
  assert.equal(wa2ConfigStatus(VALID_ENV).state, 'configured');
});

test('envia Bearer e Request ID UUID somente ao mock server-side', async () => {
  let captured;
  const client = clientWith(async (_url, options) => {
    captured = options;
    return jsonResponse({ ok: true, status: 'ok' });
  });
  await client.getHealth();
  assert.equal(captured.headers.authorization, `Bearer ${PLACEHOLDER_SECRET}`);
  assert.match(
    captured.headers['x-request-id'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(captured.headers['idempotency-key'], undefined);
  assert.equal(captured.redirect, 'error');
});

test('aceita contrato real de connect e adiciona Idempotency-Key', async () => {
  let captured;
  const client = clientWith(async (_url, options) => {
    captured = options;
    return jsonResponse({
      instanceId: 'instance-1',
      status: 'connecting',
      enqueued: true,
      jobId: 'job-connect-1',
    });
  });
  const result = await client.connectInstance('instance-1', 'new_qr');
  assert.match(
    captured.headers['idempotency-key'],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(captured.method, 'POST');
  assert.deepEqual(JSON.parse(captured.body), { mode: 'new_qr' });
  assert.deepEqual(result, {
    instanceId: 'instance-1',
    status: 'connecting',
    enqueued: true,
    jobId: 'job-connect-1',
  });
});

test('aceita contrato real de disconnect e sempre preserva a sessão', async () => {
  let captured;
  const client = clientWith(async (_url, options) => {
    captured = options;
    return jsonResponse({
      instanceId: 'instance-1',
      status: 'disconnecting',
      enqueued: false,
      jobId: null,
    });
  });
  const result = await client.disconnectInstance('instance-1');
  assert.deepEqual(JSON.parse(captured.body), { preserveSession: true });
  assert.deepEqual(result, {
    instanceId: 'instance-1',
    status: 'disconnecting',
    enqueued: false,
    jobId: null,
  });
});

test('aceita contrato real de sync e retorna somente campos sanitizados', async () => {
  const client = clientWith(async () => jsonResponse({
    instanceId: 'instance-1',
    scope: 'history',
    jobId: 'job-sync-1',
    deduped: true,
    ignoredRemoteField: 'não deve retornar',
  }));
  const result = await client.syncInstance('instance-1', 'history');
  assert.deepEqual(result, {
    instanceId: 'instance-1',
    scope: 'history',
    jobId: 'job-sync-1',
    deduped: true,
  });
});

test('não trata accepted ou queued como contrato de mutação WA2', async () => {
  const client = clientWith(async () => jsonResponse({
    accepted: true,
    queued: true,
    status: 'queued',
  }));
  await assert.rejects(
    () => client.connectInstance('instance-1', 'auto'),
    (error) => error.code === 'WA2_RESPONSE_INVALID',
  );
});

test('rejeita modo de conexão e escopo de sync desconhecidos sem chamar fetch', () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return jsonResponse({});
  });
  assert.throws(() => client.connectInstance('instance-1', 'destroy'));
  assert.throws(() => client.syncInstance('instance-1', 'everything'));
  assert.equal(calls, 0);
});

test('timeout aborta a requisição sem expor detalhe do transporte', async () => {
  const env = { ...VALID_ENV, WA2_INTERNAL_API_TIMEOUT_MS: '500' };
  const client = clientWith((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')));
  }), env);
  await assert.rejects(
    () => client.getHealth(),
    (error) => error instanceof Wa2Error && error.code === 'WA2_TIMEOUT',
  );
});

test('resposta 401 é sanitizada e não inclui segredo ou corpo remoto', async () => {
  const client = clientWith(async () => jsonResponse({
    error: { code: 'AUTH_INVALID', message: `leak ${PLACEHOLDER_SECRET}` },
  }, { status: 401 }));
  await assert.rejects(() => client.getHealth(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.remoteCode, 'AUTH_INVALID');
    assert.equal(error.message.includes(PLACEHOLDER_SECRET), false);
    assert.equal(error.message.includes('leak'), false);
    return true;
  });
});

test('resposta 429 preserva Retry-After seguro', async () => {
  const client = clientWith(async () =>
    jsonResponse({ code: 'RATE_LIMIT' }, { status: 429, headers: { 'retry-after': '30' } }));
  await assert.rejects(() => client.getHealth(), (error) => {
    assert.equal(error.retryAfter, '30');
    assert.equal(error.remoteCode, 'RATE_LIMIT');
    return true;
  });
});

test('resposta 500 não expõe corpo remoto', async () => {
  const client = clientWith(async () =>
    jsonResponse({ error: { message: 'stack interna e sessionKey' } }, { status: 500 }));
  await assert.rejects(() => client.getHealth(), (error) => {
    assert.equal(error.message.includes('sessionKey'), false);
    assert.equal(error.message.includes('stack interna'), false);
    return true;
  });
});

test('JSON inválido é tratado como resposta sanitizada inválida', async () => {
  const client = clientWith(async () => new Response('{quebrado', { status: 200 }));
  await assert.rejects(
    () => client.getHealth(),
    (error) => error.code === 'WA2_RESPONSE_INVALID',
  );
});

test('resposta declarada acima do limite é rejeitada antes do parsing', async () => {
  const client = clientWith(async () => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(2 * 1024 * 1024) },
  }));
  await assert.rejects(
    () => client.getHealth(),
    (error) => error.code === 'WA2_RESPONSE_TOO_LARGE',
  );
});

test('codifica instanceId seguro ao montar a rota fechada', async () => {
  let capturedUrl;
  const client = clientWith(async (url) => {
    capturedUrl = url;
    return jsonResponse({ instanceId: 'tenant:main@wa', status: 'connected' });
  });
  await client.getInstanceStatus('tenant:main@wa');
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/tenant%3Amain%40wa/status',
  );
});

test('impede injeção de caminho pelo instanceId', () => {
  let called = false;
  const client = clientWith(async () => {
    called = true;
    return jsonResponse({});
  });
  assert.throws(
    () => client.getInstanceStatus('../health?x=1'),
    (error) => error.code === 'WA2_INSTANCE_ID_INVALID',
  );
  assert.equal(called, false);
});

test('aceita o contrato real completo do QR WA2', () => {
  const qr = parseWa2Qr({
    instanceId: 'instance-1',
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    updatedAt: '2098-12-31T23:59:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiresAtHeuristic: true,
  });
  assert.deepEqual({
    contentType: qr.contentType,
    expiresAt: qr.expiresAt,
    expiresAtHeuristic: qr.expiresAtHeuristic,
    updatedAt: qr.updatedAt,
  }, {
    contentType: 'image/png',
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiresAtHeuristic: true,
    updatedAt: '2098-12-31T23:59:00.000Z',
  });
  assert.equal(Buffer.isBuffer(qr.bytes), true);
});

test('rejeita ausência de qrCode', () => {
  assert.throws(() => parseWa2Qr({
    expiresAt: '2099-01-01T00:00:00.000Z',
  }), { code: 'WA2_QR_INVALID' });
});

test('rejeita campo antigo dataUrl quando qrCode não existe', () => {
  assert.throws(() => parseWa2Qr({
    dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }), { code: 'WA2_QR_INVALID' });
});

test('rejeita QR com MIME ou base64 inválido', () => {
  for (const qrCode of [
    `data:text/html;base64,${PNG_BASE64}`,
    'data:image/png;base64,%%%invalido%%%',
  ]) {
    assert.throws(() => parseWa2Qr({
      qrCode,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }), { code: 'WA2_QR_INVALID' });
  }
});

test('rejeita expiresAt ausente', () => {
  assert.throws(() => parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
  }), { code: 'WA2_QR_INVALID' });
});

test('rejeita expiresAt inválido', () => {
  assert.throws(() => parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: 'amanhã',
  }), { code: 'WA2_QR_INVALID' });
});

test('rejeita expiresAt expirado', () => {
  assert.throws(() => parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2020-01-01T00:00:00.000Z',
  }), { code: 'WA2_QR_EXPIRED' });
});

test('aceita expiresAtHeuristic true', () => {
  const qr = parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiresAtHeuristic: true,
  });
  assert.equal(qr.expiresAtHeuristic, true);
});

test('aceita expiresAtHeuristic false', () => {
  const qr = parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiresAtHeuristic: false,
  });
  assert.equal(qr.expiresAtHeuristic, false);
});

test('rejeita expiresAtHeuristic como string ou data', () => {
  for (const expiresAtHeuristic of ['true', '2099-01-01T00:00:00.000Z']) {
    assert.throws(() => parseWa2Qr({
      qrCode: `data:image/png;base64,${PNG_BASE64}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtHeuristic,
    }), { code: 'WA2_QR_INVALID' });
  }
});

test('valida updatedAt quando presente', () => {
  assert.throws(() => parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    updatedAt: 'data-inválida',
  }), { code: 'WA2_QR_INVALID' });
});

test('retorno do QR não contém qrCode nem data URL', () => {
  const qr = parseWa2Qr({
    qrCode: `data:image/png;base64,${PNG_BASE64}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiresAtHeuristic: false,
  });
  assert.equal(Object.hasOwn(qr, 'qrCode'), false);
  assert.equal(Object.values(qr).some((value) =>
    typeof value === 'string' && value.startsWith('data:')), false);
});

test('rejeita QR acima do limite', () => {
  const oversized = Buffer.alloc(512 * 1024 + 1, 1).toString('base64');
  assert.throws(
    () => parseWa2Qr({
      qrCode: `data:image/png;base64,${oversized}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    (error) => ['WA2_QR_INVALID', 'WA2_QR_TOO_LARGE'].includes(error.code),
  );
});

test('view escapa dados remotos e não recebe configuração secreta', () => {
  const html = wa2DashboardView({
    configStatus: {
      state: 'configured',
      errors: [],
    },
    health: { ok: true, status: 'ok' },
    instances: [{
      id: 'instance-1',
      name: '<script>alert(1)</script>',
      role: 'primary',
      phone: '5538999990000',
      status: 'connected',
      isDefault: true,
    }],
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes(PLACEHOLDER_SECRET), false);
});
