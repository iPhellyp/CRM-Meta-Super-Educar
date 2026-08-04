import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  Wa2Error,
  brazilianPhoneAliases,
  classifyWa2Jid,
  createWa2Client,
  parseWa2Qr,
  validateWa2Config,
  wa2ConfigStatus,
} from '../src/wa2.js';
import {
  leadWa2View,
  reconciliationItemsView,
  wa2DashboardView,
  wa2LabelBindingsView,
  wa2LabelJobsView,
  wa2LinkConfirmView,
} from '../src/views.js';
import {
  WA2_LINK_RESOLUTION_PURPOSE,
  createWa2ResolutionToken,
  wa2ResolutionTokenIsValid,
} from '../src/wa2-link-token.js';

const PLACEHOLDER_SECRET = 'placeholder-for-local-tests';
const VALID_ENV = Object.freeze({
  NODE_ENV: 'test',
  WA2_INTERNAL_API_BASE_URL: 'http://localhost:3100',
  WA2_INTERNAL_API_SECRET: PLACEHOLDER_SECRET,
  WA2_INTERNAL_API_TIMEOUT_MS: '1000',
});
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('reconciliação exibe a causa remota sanitizada em linguagem operacional', () => {
  const codes = [
    ['CONTACT_NOT_FOUND', 'Não encontrado no WA2'],
    ['WA2_LID_UNRESOLVED', 'LID não resolvido'],
    ['CONTACT_AMBIGUOUS', 'Conflito'],
    ['WA2_AUTHENTICATION_FAILED', 'Erro de autenticação/configuração'],
    ['WA2_RATE_LIMITED', 'Limite do WA2'],
    ['WA2_TEMPORARY_FAILURE', 'Falha temporária do WA2'],
    ['WA2_API_ROUTE_NOT_FOUND', 'Incompatibilidade de API'],
  ];
  const html = reconciliationItemsView({
    runId: 'run-1',
    items: codes.map(([last_error_code], index) => ({
      lead_id: `lead-${index}`,
      lead_name: `Lead ${index}`,
      result: 'ERROR',
      attempts: 1,
      last_error_code,
      finished_at: null,
    })),
  });
  for (const [, label] of codes) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, />WA2_HTTP_ERROR</);
});

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

const BY_PHONE_RESPONSE = Object.freeze({
  contact: {
    id: 'contact-1',
    phoneNormalized: '5538999990000',
    name: 'Contato WA2',
    jid: '5538999990000@s.whatsapp.net',
  },
  chat: {
    id: 'chat-1',
    jid: '5538999990000@s.whatsapp.net',
    lastInboundAt: '2026-07-27T12:00:00.000Z',
    lastOutboundAt: null,
  },
  labels: [{ waLabelId: 'label-1', name: 'Não retornar' }],
  raw: 'não retornar',
});

test('consulta contato por telefone e remove campos extras', async () => {
  let capturedUrl;
  let capturedOptions;
  const client = clientWith(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse(BY_PHONE_RESPONSE);
  });
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/instance-1/contacts/by-phone/5538999990000',
  );
  assert.equal(capturedOptions.headers['idempotency-key'], undefined);
  assert.deepEqual(result, {
    contact: {
      id: 'contact-1',
      phoneNormalized: '5538999990000',
      name: 'Contato WA2',
      jid: '5538999990000@s.whatsapp.net',
    },
    chat: {
      id: 'chat-1',
      jid: '5538999990000@s.whatsapp.net',
    },
  });
  assert.equal(Object.hasOwn(result, 'labels'), false);
});

test('aceita wrapper data no contrato by-phone', async () => {
  const client = clientWith(async () => jsonResponse({ data: BY_PHONE_RESPONSE }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.chat.id, 'chat-1');
});

test('aceita contato by-phone sem chat sem criar dado inventado', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    chat: null,
  }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.chat, null);
});

test('preserva 404 e 409 do by-phone como erros identificáveis', async () => {
  for (const [status, code] of [[404, 'CONTACT_NOT_FOUND'], [409, 'CONTACT_AMBIGUOUS']]) {
    const client = clientWith(async () => jsonResponse({ error: { code } }, { status }));
    await assert.rejects(
      () => client.getContactByPhone('instance-1', '5538999990000'),
      (error) => error.status === status && error.remoteCode === code,
    );
  }
});

test('rejeita telefone retornado diferente do solicitado', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    contact: { ...BY_PHONE_RESPONSE.contact, phoneNormalized: '553833330000' },
  }));
  await assert.rejects(
    () => client.getContactByPhone('instance-1', '5538999990000'),
    (error) => error.code === 'WA2_PHONE_MISMATCH',
  );
});

test('rejeita contact ausente ou com id vazio', async () => {
  for (const contact of [null, { ...BY_PHONE_RESPONSE.contact, id: '' }]) {
    const client = clientWith(async () => jsonResponse({ ...BY_PHONE_RESPONSE, contact }));
    await assert.rejects(
      () => client.getContactByPhone('instance-1', '5538999990000'),
      (error) => error.code === 'WA2_CONTACT_INVALID',
    );
  }
});

test('rejeita chat sem id', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    chat: { ...BY_PHONE_RESPONSE.chat, id: '' },
  }));
  await assert.rejects(
    () => client.getContactByPhone('instance-1', '5538999990000'),
    (error) => error.code === 'WA2_CHAT_INVALID',
  );
});

test('rejeita contact.jid e chat.jid de telefones diferentes', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    chat: { ...BY_PHONE_RESPONSE.chat, jid: '553833330000@s.whatsapp.net' },
  }));
  await assert.rejects(
    () => client.getContactByPhone('instance-1', '5538999990000'),
    (error) => error.code === 'WA2_JID_MISMATCH',
  );
});

test('aceita sufixos individuais garantidos pelo WA2 para o mesmo telefone', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    contact: { ...BY_PHONE_RESPONSE.contact, jid: '5538999990000@c.us' },
  }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.contact.jid, '5538999990000@c.us');
  assert.equal(result.chat.jid, '5538999990000@s.whatsapp.net');
});

test('aceita alias brasileiro unívoco retornado pelo WA2', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    contact: {
      ...BY_PHONE_RESPONSE.contact,
      jid: '553899990000@s.whatsapp.net',
    },
    chat: {
      ...BY_PHONE_RESPONSE.chat,
      jid: '553899990000@s.whatsapp.net',
    },
  }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.contact.phoneNormalized, '5538999990000');
  assert.equal(result.chat.jid, '553899990000@s.whatsapp.net');
});

test('canonicaliza PN legado móvel sem perder o alias da resposta WA2', async () => {
  let capturedUrl;
  const client = clientWith(async (url) => {
    capturedUrl = url;
    return jsonResponse({
      contact: {
        id: 'contact-legacy',
        phoneNormalized: '553888515846',
        name: 'Matheus PH',
        jid: '553888515846@s.whatsapp.net',
      },
      chat: { id: 'chat-legacy', jid: '123456@lid' },
    });
  });
  const result = await client.getContactByPhone('instance-1', '553888515846');
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/instance-1/contacts/by-phone/5538988515846',
  );
  assert.equal(result.contact.phoneNormalized, '5538988515846');
  assert.equal(result.contact.sourcePhoneNormalized, '553888515846');
  assert.deepEqual(result.contact.phoneAliases, [
    '553888515846',
    '5538988515846',
    '3888515846',
    '38988515846',
  ]);
  assert.equal(result.chat.jid, '123456@lid');
});

test('não cria alias móvel para telefone fixo sem evidência explícita', () => {
  assert.deepEqual(
    [...brazilianPhoneAliases('553833330000')],
    ['553833330000', '3833330000'],
  );
  assert.deepEqual(
    [...brazilianPhoneAliases('553888515846')],
    ['553888515846', '3888515846'],
  );
  assert.equal(
    brazilianPhoneAliases('553888515846', { confirmedMobile: true }).has('5538988515846'),
    true,
  );
});

test('aceita chat LID somente quando contato canônico resolve o telefone', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    chat: {
      ...BY_PHONE_RESPONSE.chat,
      jid: '123@lid',
    },
  }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.chat.jid, '123@lid');
});

test('preserva classificação LID histórica e sinal de etiqueta inversa', async () => {
  const client = clientWith(async () => jsonResponse({
    ...BY_PHONE_RESPONSE,
    chat: { ...BY_PHONE_RESPONSE.chat, jid: '123@lid' },
    resolution: 'LID_HISTORICAL',
    labeledCrm: true,
  }));
  const result = await client.getContactByPhone('instance-1', '5538999990000');
  assert.equal(result.resolution, 'LID_HISTORICAL');
  assert.equal(result.labeledCrm, true);
});

test('lista inversa aceita somente identidade etiquetada sanitizada', async () => {
  let capturedUrl;
  const client = clientWith(async (url) => {
    capturedUrl = url;
    return jsonResponse({ data: [{
      chatId: 'chat-lid-1',
      jid: '123@lid',
      phoneNormalized: '5538999990000',
      resolution: 'LID_HISTORICAL',
      labels: [{ waLabelId: 'crm-01', name: 'CRM 01' }],
      ignored: 'campo removido',
    }] });
  });
  const rows = await client.listLabeledIdentities('instance-1');
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/instance-1/identities/labeled',
  );
  assert.deepEqual(rows, [{
    chatId: 'chat-lid-1',
    jid: '123@lid',
    phoneNormalized: '5538999990000',
    resolution: 'LID_HISTORICAL',
    labels: [{ id: 'crm-01', name: 'CRM 01' }],
  }]);
});

test('classifica e rejeita LID, grupo e broadcast no by-phone', async () => {
  assert.equal(classifyWa2Jid('123@lid'), 'lid');
  assert.equal(classifyWa2Jid('123@g.us'), 'group');
  assert.equal(classifyWa2Jid('status@broadcast'), 'status');
  assert.equal(classifyWa2Jid('123@broadcast'), 'broadcast');
  const rejected = [
    ['123@lid', 'WA2_LID_UNRESOLVED'],
    ['123@g.us', 'WA2_GROUP_UNSUPPORTED'],
    ['status@broadcast', 'WA2_BROADCAST_UNSUPPORTED'],
    ['123@broadcast', 'WA2_BROADCAST_UNSUPPORTED'],
  ];
  for (const [jid, code] of rejected) {
    const client = clientWith(async () => jsonResponse({
      ...BY_PHONE_RESPONSE,
      contact: { ...BY_PHONE_RESPONSE.contact, jid },
    }));
    await assert.rejects(
      () => client.getContactByPhone('instance-1', '5538999990000'),
      (error) => error.code === code,
    );
  }
});

test('rejeita telefone não normalizado antes de chamar by-phone', () => {
  let called = false;
  const client = clientWith(async () => {
    called = true;
    return jsonResponse(BY_PHONE_RESPONSE);
  });
  assert.throws(
    () => client.getContactByPhone('instance-1', '(38) 99999-0000'),
    (error) => error.code === 'WA2_PHONE_INVALID',
  );
  assert.equal(called, false);
});

test('erro by-phone não expõe segredo nem mensagem remota', async () => {
  const client = clientWith(async () => jsonResponse({
    error: {
      code: 'CONTACT_FAILURE',
      message: `erro interno ${PLACEHOLDER_SECRET}`,
    },
  }, { status: 500 }));
  await assert.rejects(
    () => client.getContactByPhone('instance-1', '5538999990000'),
    (error) =>
      !error.message.includes(PLACEHOLDER_SECRET) &&
      !error.message.includes('erro interno'),
  );
});

test('lista etiquetas da instância com o contrato real e descarta extras', async () => {
  let capturedUrl;
  let capturedOptions;
  const client = clientWith(async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse({
      instanceId: 'instance-1',
      labels: [{
        waLabelId: '10',
        name: 'CRM 01 Em atendimento',
        color: 3,
        predefined: false,
        updatedAt: '2026-07-27T12:00:00.000Z',
        secretExtra: 'descartar',
      }],
      extra: true,
    });
  });
  assert.deepEqual(await client.listLabels('instance-1'), [{
    id: '10',
    name: 'CRM 01 Em atendimento',
  }]);
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/instance-1/labels',
  );
  assert.equal(capturedOptions.method, 'GET');
  assert.equal(capturedOptions.headers['idempotency-key'], undefined);
});

test('lista etiquetas do chat usando IDs validados e rota exata', async () => {
  let capturedUrl;
  const client = clientWith(async (url) => {
    capturedUrl = url;
    return jsonResponse({
      instanceId: 'instance-1',
      chatId: 'chat_1',
      labels: [{ waLabelId: 'label-1', name: 'CRM 02 Qualificado', color: 4 }],
    });
  });
  assert.deepEqual(await client.listChatLabels('instance-1', 'chat_1'), [{
    id: 'label-1',
    name: 'CRM 02 Qualificado',
  }]);
  assert.equal(
    capturedUrl,
    'http://localhost:3100/api/internal/v1/instances/instance-1/chats/chat_1/labels',
  );
});

test('aplica e remove etiqueta com PUT/DELETE idempotentes e sem payload', async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, options });
    const operation = options.method === 'PUT' ? 'apply' : 'remove';
    return jsonResponse({
      operation,
      changed: operation === 'apply',
      enqueued: operation === 'apply',
      jobId: operation === 'apply' ? 'wa2-job-1' : null,
      extra: 'descartar',
    }, { status: operation === 'apply' ? 202 : 200 });
  });
  assert.deepEqual(
    await client.applyChatLabel('instance-1', 'chat_1', 'label-1', {
      idempotencyKey: 'crm-label:apply-test-1',
    }),
    { operation: 'apply', changed: true, enqueued: true, jobId: 'wa2-job-1' },
  );
  assert.deepEqual(
    await client.removeChatLabel('instance-1', 'chat_1', 'label-1', {
      idempotencyKey: 'crm-label:remove-test-1',
    }),
    { operation: 'remove', changed: false, enqueued: false, jobId: null },
  );
  assert.deepEqual(calls.map((call) => call.options.method), ['PUT', 'DELETE']);
  for (const [index, call] of calls.entries()) {
    assert.equal(
      call.url,
      'http://localhost:3100/api/internal/v1/instances/instance-1/chats/chat_1/labels/label-1',
    );
    assert.equal(call.options.body, undefined);
    assert.equal(
      call.options.headers['idempotency-key'],
      index === 0 ? 'crm-label:apply-test-1' : 'crm-label:remove-test-1',
    );
    assert.equal(call.options.redirect, 'error');
  }
});

test('rejeita IDs inseguros de chat e etiqueta antes do fetch', () => {
  let called = false;
  const client = clientWith(async () => {
    called = true;
    return jsonResponse({});
  });
  assert.throws(
    () => client.listChatLabels('instance-1', '../chat'),
    { code: 'WA2_RESOURCE_ID_INVALID' },
  );
  assert.throws(
    () => client.applyChatLabel('instance-1', 'chat-1', 'label/1'),
    { code: 'WA2_RESOURCE_ID_INVALID' },
  );
  assert.equal(called, false);
});

test('erros 404, 409 e 422 de etiquetas são identificáveis e sanitizados', async () => {
  for (const [status, code] of [
    [404, 'LABEL_NOT_FOUND'],
    [409, 'IDEMPOTENCY_IN_PROGRESS'],
    [422, 'UNSUPPORTED_JID'],
  ]) {
    const client = clientWith(async () => jsonResponse({
      error: { code, message: `detalhe remoto ${PLACEHOLDER_SECRET}` },
    }, { status }));
    await assert.rejects(
      () => client.applyChatLabel('instance-1', 'chat-1', 'label-1'),
      (error) =>
        error.status === status &&
        error.remoteCode === code &&
        !error.message.includes(PLACEHOLDER_SECRET) &&
        !error.message.includes('detalhe remoto'),
    );
  }
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

test('confirmação de vínculo não confia chat, telefone ou JID a hidden inputs', () => {
  const html = wa2LinkConfirmView({
    lead: { id: 'lead-local', name: '<Lead>' },
    instance: { id: 'instance-local', name: 'Instância', remote_instance_id: 'remote-1' },
    resolved: {
      contact: { id: 'contact-1', name: '<Contato>' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
    phoneNormalized: '5538999990000',
    currentLink: null,
    expectedAction: 'CREATE',
    expectedLinkId: null,
    resolutionToken: 'timestamp.signature-placeholder',
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('name="chatId"'), false);
  assert.equal(html.includes('name="contactId"'), false);
  assert.equal(html.includes('name="jid"'), false);
  assert.equal(html.includes('name="phoneNormalized"'), false);
  assert.equal(html.includes('name="tenant"'), false);
  assert.equal(html.includes('name="tenantId"'), false);
  assert.equal(html.includes('name="remoteInstanceId"'), false);
  assert.equal(html.includes('name="resolutionToken"'), true);
  assert.equal(html.includes('5538999990000@s.whatsapp.net'), false);
  assert.equal(html.includes('&lt;Contato&gt;'), true);
  assert.equal(html.includes('name="expectedAction" value="CREATE"'), true);
  assert.equal(html.includes('name="expectedLinkId" value=""'), true);
});

test('confirmação de substituição inclui somente o ID local do vínculo esperado', () => {
  const expectedLinkId = '11111111-1111-4111-8111-111111111111';
  const html = wa2LinkConfirmView({
    lead: { id: 'lead-local', name: 'Lead' },
    instance: { id: 'instance-local', name: 'Instância', remote_instance_id: 'remote-1' },
    resolved: {
      contact: { id: 'contact-1', name: 'Contato' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
    phoneNormalized: '5538999990000',
    currentLink: { id: expectedLinkId },
    expectedAction: 'REPLACE',
    expectedLinkId,
    resolutionToken: 'timestamp.signature-placeholder',
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('name="expectedAction" value="REPLACE"'), true);
  assert.equal(
    html.includes(`name="expectedLinkId" value="${expectedLinkId}"`),
    true,
  );
  for (const field of [
    'phoneNormalized',
    'contactId',
    'chatId',
    'jid',
    'tenant',
    'tenantId',
    'remoteInstanceId',
  ]) {
    assert.equal(html.includes(`name="${field}"`), false);
  }
});

test('view do lead mascara JID e mantém ações por IDs locais', () => {
  const html = leadWa2View({
    lead: {
      id: 'lead-local',
      name: 'Lead',
      phone: '(38) 99999-0000',
      phone_normalized: '5538999990000',
      source: 'MANUAL',
    },
    instances: [{
      id: 'instance-local',
      remote_instance_id: 'remote-1',
      name: 'Instância',
      is_default: true,
    }],
    links: [{
      id: 'link-local',
      instance_name: 'Instância',
      remote_contact_id: 'contact-1',
      remote_chat_id: 'chat-1',
      jid: '5538999990000@s.whatsapp.net',
      last_verified_at: '2026-07-27T12:00:00.000Z',
    }],
    labelSync: [{
      instance_name: 'Instância',
      binding_id: 'binding-local',
      remote_label_id: 'label-2',
      remote_label_name: 'CRM 02 Qualificado',
      job_id: 'job-local',
      job_status: 'FAILED',
      job_attempts: 5,
      last_error_code: 'WA2_TIMEOUT',
      last_error_message: 'Tempo esgotado',
    }],
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('5538999990000@s.whatsapp.net'), false);
  assert.equal(html.includes('5538••••00@s.whatsapp.net'), true);
  assert.equal(html.includes('value="instance-local"'), true);
  assert.equal(html.includes('value="link-local"'), true);
  assert.equal(html.includes('CRM 02 Qualificado'), true);
  assert.equal(html.includes('WA2_TIMEOUT'), true);
});

test('painel de bindings escapa dados e envia instância/binding por IDs locais', () => {
  const html = wa2LabelBindingsView({
    instances: [{
      id: '11111111-1111-4111-8111-111111111111',
      remote_instance_id: 'remote-1',
      name: '<Instância>',
      enabled: true,
    }],
    selectedInstance: {
      id: '11111111-1111-4111-8111-111111111111',
      remote_instance_id: 'remote-1',
      name: '<Instância>',
      enabled: true,
    },
    labels: [{
      id: 'label-1',
      name: '<CRM 01 Em atendimento>',
    }],
    bindings: [{
      id: '22222222-2222-4222-8222-222222222222',
      stage: 'NEW',
      remote_label_id: 'label-1',
      remote_label_name: '<CRM 01 Em atendimento>',
      enabled: true,
      last_verified_at: '2026-07-27T12:00:00.000Z',
      last_attempt_status: 'FAILED',
      last_attempt_at: '2026-08-01T22:03:00.000Z',
      last_success_at: '2026-07-31T22:00:00.000Z',
      last_error_code: 'WA2_LABEL_SYNC_NOT_CONFIRMED',
      last_error: 'Erro de confirmação',
      last_error_at: '2026-08-01T22:03:00.000Z',
    }],
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('<Instância>'), false);
  assert.equal(html.includes('&lt;Instância&gt;'), true);
  assert.equal(html.includes('name="instanceId" value="11111111-1111-4111-8111-111111111111"'), true);
  assert.equal(html.includes('/wa2/label-bindings/22222222-2222-4222-8222-222222222222/verify'), true);
  assert.equal(html.includes('Última tentativa: FAILED'), true);
  assert.equal(html.includes('Último sucesso:'), true);
  assert.equal(html.includes('Última falha: WA2_LABEL_SYNC_NOT_CONFIRMED'), true);
  assert.equal(html.includes(PLACEHOLDER_SECRET), false);
  assert.equal(html.includes('rawPayload'), false);
});

test('painel de jobs permite retry somente para FAILED e escapa erro', () => {
  const html = wa2LabelJobsView({
    counts: { pending: 1, running: 1, done: 1, failed: 1, stale: 1 },
    jobs: [{
      id: '11111111-1111-4111-8111-111111111111',
      lead_name: '<Lead>',
      target_stage: 'QUALIFIED',
      target_remote_label_id: 'label-2',
      instance_name: '<Instância>',
      remote_instance_id: 'remote-1',
      status: 'FAILED',
      attempts: 5,
      max_attempts: 5,
      available_at: '2026-07-27T12:00:00.000Z',
      created_at: '2026-07-27T12:00:00.000Z',
      last_error_code: 'WA2_TIMEOUT',
      last_error_message: '<erro>',
      stale: false,
    }, {
      id: '22222222-2222-4222-8222-222222222222',
      lead_name: 'Lead 2',
      target_stage: 'MATRICULATED',
      target_remote_label_id: 'label-5',
      instance_name: 'Instância',
      status: 'RUNNING',
      attempts: 1,
      max_attempts: 5,
      created_at: '2026-07-27T12:00:00.000Z',
      stale: true,
    }],
    csrfToken: 'csrf-placeholder',
  });
  assert.equal(html.includes('<Lead>'), false);
  assert.equal(html.includes('&lt;erro&gt;'), true);
  assert.equal(
    html.includes('/wa2/label-jobs/11111111-1111-4111-8111-111111111111/retry'),
    true,
  );
  assert.equal(
    html.includes('/wa2/label-jobs/22222222-2222-4222-8222-222222222222/retry'),
    false,
  );
  assert.equal(html.includes('Processamento travado; elegível para recuperação'), true);
});

test('token de resolução aceita CREATE sem vínculo e REPLACE com vínculo assinado', () => {
  const baseContext = {
    leadId: 'lead-local',
    instanceId: 'instance-local',
    phoneNormalized: '5538999990000',
    resolved: {
      contact: { id: 'contact-1' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
  };
  const secret = 'placeholder-session-secret-with-no-production-value';
  const now = 1_800_000_000_000;
  const createContext = {
    ...baseContext,
    expectedAction: 'CREATE',
    expectedLinkId: null,
  };
  const replaceContext = {
    ...baseContext,
    expectedAction: 'REPLACE',
    expectedLinkId: '11111111-1111-4111-8111-111111111111',
  };
  const createToken = createWa2ResolutionToken(createContext, { secret, now });
  const replaceToken = createWa2ResolutionToken(replaceContext, { secret, now });
  assert.equal(
    wa2ResolutionTokenIsValid(createToken, createContext, { secret, now }),
    true,
  );
  assert.equal(
    wa2ResolutionTokenIsValid(replaceToken, replaceContext, { secret, now }),
    true,
  );
});

test('token vincula CREATE, REPLACE e expectedLinkId à assinatura', () => {
  const secret = 'placeholder-session-secret-with-no-production-value';
  const now = 1_800_000_000_000;
  const createContext = {
    leadId: 'lead-local',
    instanceId: 'instance-local',
    phoneNormalized: '5538999990000',
    resolved: {
      contact: { id: 'contact-1' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
    expectedAction: 'CREATE',
    expectedLinkId: null,
  };
  const replaceContext = {
    ...createContext,
    expectedAction: 'REPLACE',
    expectedLinkId: '11111111-1111-4111-8111-111111111111',
  };
  const createToken = createWa2ResolutionToken(createContext, { secret, now });
  const replaceToken = createWa2ResolutionToken(replaceContext, { secret, now });
  assert.equal(
    wa2ResolutionTokenIsValid(createToken, replaceContext, { secret, now }),
    false,
  );
  assert.equal(
    wa2ResolutionTokenIsValid(replaceToken, createContext, { secret, now }),
    false,
  );
  assert.equal(wa2ResolutionTokenIsValid(replaceToken, {
    ...replaceContext,
    expectedLinkId: '22222222-2222-4222-8222-222222222222',
  }, { secret, now }), false);
});

test('token continua detectando chat alterado, expiração e adulteração', () => {
  const context = {
    leadId: 'lead-local',
    instanceId: 'instance-local',
    phoneNormalized: '5538999990000',
    resolved: {
      contact: { id: 'contact-1' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
    expectedAction: 'CREATE',
    expectedLinkId: null,
  };
  const secret = 'placeholder-session-secret-with-no-production-value';
  const now = 1_800_000_000_000;
  const token = createWa2ResolutionToken(context, { secret, now });
  assert.equal(wa2ResolutionTokenIsValid(token, {
    ...context,
    resolved: {
      ...context.resolved,
      chat: { ...context.resolved.chat, id: 'chat-2' },
    },
  }, { secret, now }), false);
  assert.equal(
    wa2ResolutionTokenIsValid(token, context, { secret, now: now + 10 * 60 * 1000 + 1 }),
    false,
  );
  assert.equal(
    wa2ResolutionTokenIsValid(
      `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`,
      context,
      { secret, now },
    ),
    false,
  );
});

test('purpose/version e domínio próprio participam da assinatura HMAC', () => {
  const context = {
    leadId: 'lead-local',
    instanceId: 'instance-local',
    phoneNormalized: '5538999990000',
    resolved: {
      contact: { id: 'contact-1' },
      chat: { id: 'chat-1', jid: '5538999990000@s.whatsapp.net' },
    },
    expectedAction: 'CREATE',
    expectedLinkId: null,
  };
  const secret = 'placeholder-session-secret-with-no-production-value';
  const now = 1_800_000_000_000;
  const timestamp = String(now);
  const payload = JSON.stringify({
    purpose: WA2_LINK_RESOLUTION_PURPOSE,
    leadId: context.leadId,
    instanceId: context.instanceId,
    phoneNormalized: context.phoneNormalized,
    remoteContactId: context.resolved.contact.id,
    remoteChatId: context.resolved.chat.id,
    jid: context.resolved.chat.jid,
    expectedAction: context.expectedAction,
    expectedLinkId: context.expectedLinkId,
    timestamp,
  });
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(`crm-meta-super-educar:wa2-link-resolution:hmac:v1\0${payload}`)
    .digest('hex');
  assert.equal(
    createWa2ResolutionToken(context, { secret, now }),
    `${timestamp}.${expectedSignature}`,
  );
});
