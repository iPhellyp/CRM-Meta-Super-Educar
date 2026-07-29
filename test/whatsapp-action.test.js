import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWhatsAppActionHandler,
  createWhatsAppOpenedHandler,
} from '../src/whatsapp-action.js';

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const WHATSAPP_URL = 'https://wa.me/5538991142298?text=Ol%C3%A1';

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    redirected: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    redirect(status, location) {
      this.statusCode = status;
      this.redirected = location;
      return this;
    },
    sendStatus(status) {
      this.statusCode = status;
      this.body = null;
      return this;
    },
  };
}

function handlerFixture(overrides = {}) {
  const calls = { history: 0 };
  const lead = { id: LEAD_ID, name: 'Ana', phone: '(38) 99114-2298', stage: 'NEW' };
  const dependencies = {
    getLeadById: async () => lead,
    getTenantWhatsAppMessage: async () => 'Olá, {{nome}}',
    getWhatsAppUrl: () => WHATSAPP_URL,
    recordWhatsAppOpened: async () => {
      calls.history += 1;
      return { activity_type: 'WHATSAPP_OPENED' };
    },
    selectBestLeadPhone: () => ({ phoneNormalized: '5538991142298' }),
    ...overrides,
  };
  return {
    calls,
    lead,
    handler: createWhatsAppActionHandler(dependencies),
  };
}

function requestMock({ accept = 'text/html', id = LEAD_ID } = {}) {
  return {
    params: { id },
    user: { sub: 'admin@example.com' },
    get(name) {
      return name.toLowerCase() === 'accept' ? accept : '';
    },
  };
}

test('fallback HTML registra abertura uma vez, preserva stage e responde 303 para wa.me', async () => {
  const fixture = handlerFixture();
  const response = responseMock();
  await fixture.handler(requestMock(), response);

  assert.equal(response.statusCode, 303);
  assert.match(response.redirected, /^https:\/\/wa\.me\//);
  assert.equal(fixture.calls.history, 1);
  assert.equal(fixture.lead.stage, 'NEW');
});

test('fluxo JSON retorna redirectUrl e impede cache', async () => {
  const fixture = handlerFixture();
  const response = responseMock();
  await fixture.handler(requestMock({ accept: 'application/json' }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, redirectUrl: WHATSAPP_URL });
  assert.equal(response.headers['cache-control'], 'private, no-store, max-age=0');
  assert.equal(fixture.calls.history, 1);
});

test('JSON sanitiza lead inexistente, telefone inválido e falha inesperada', async (t) => {
  await t.test('lead inexistente', async () => {
    const fixture = handlerFixture({ getLeadById: async () => null });
    const response = responseMock();
    await fixture.handler(requestMock({ accept: 'application/json' }), response);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, {
      ok: false,
      error: { code: 'LEAD_NOT_FOUND', message: 'Lead não encontrado.' },
    });
    assert.equal(fixture.calls.history, 0);
  });

  await t.test('telefone inválido', async () => {
    const fixture = handlerFixture({
      selectBestLeadPhone: () => ({ phoneNormalized: null }),
    });
    const response = responseMock();
    await fixture.handler(requestMock({ accept: 'application/json' }), response);
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body.error, {
      code: 'PHONE_INVALID',
      message: 'O telefone deste lead é inválido.',
    });
    assert.equal(fixture.calls.history, 0);
  });

  await t.test('falha inesperada', async () => {
    const fixture = handlerFixture({
      recordWhatsAppOpened: async () => {
        throw new Error('detalhe interno com telefone');
      },
    });
    const response = responseMock();
    await fixture.handler(requestMock({ accept: 'application/json' }), response);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body.error, {
      code: 'WHATSAPP_UNAVAILABLE',
      message: 'Não foi possível abrir o WhatsApp agora. Tente novamente.',
    });
    assert.equal(JSON.stringify(response.body).includes('detalhe interno'), false);
  });
});

test('UUID inválido usa LEAD_NOT_FOUND em JSON e preserva texto HTML tradicional', async () => {
  const fixture = handlerFixture();
  const jsonResponse = responseMock();
  await fixture.handler(
    requestMock({ accept: 'application/json', id: 'invalido' }),
    jsonResponse,
  );
  assert.equal(jsonResponse.statusCode, 404);
  assert.equal(jsonResponse.body.error.code, 'LEAD_NOT_FOUND');

  const htmlResponse = responseMock();
  await fixture.handler(requestMock({ id: 'invalido' }), htmlResponse);
  assert.equal(htmlResponse.statusCode, 404);
  assert.equal(htmlResponse.body, 'Lead inválido.');
});

test('URL não estritamente pertencente a https://wa.me/ é rejeitada antes do histórico', async () => {
  for (const redirectUrl of [
    'http://wa.me/5538991142298',
    'https://wa.me.evil.example/5538991142298',
    'https://example.com/https://wa.me/5538991142298',
    'https://wa.me:8443/5538991142298',
    'valor com https://wa.me/5538991142298',
  ]) {
    const fixture = handlerFixture({ getWhatsAppUrl: () => redirectUrl });
    const response = responseMock();
    await fixture.handler(requestMock({ accept: 'application/json' }), response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error.code, 'WHATSAPP_UNAVAILABLE');
    assert.equal(fixture.calls.history, 0);
  }
});

test('logging responde 204, valida tenant pelo lead e deduplica por cinco segundos', async () => {
  let timestamp = 1_000;
  let history = 0;
  const handler = createWhatsAppOpenedHandler({
    getLeadById: async () => ({ id: LEAD_ID, tenant_id: 'tenant-a' }),
    recordWhatsAppOpened: async () => { history += 1; },
    now: () => timestamp,
  });
  const first = responseMock();
  await handler(requestMock(), first);
  assert.equal(first.statusCode, 204);
  assert.equal(history, 1);

  const duplicate = responseMock();
  await handler(requestMock(), duplicate);
  assert.equal(duplicate.statusCode, 204);
  assert.equal(history, 1);

  timestamp += 5_000;
  const later = responseMock();
  await handler(requestMock(), later);
  assert.equal(later.statusCode, 204);
  assert.equal(history, 2);
});

test('logging rejeita UUID e lead fora do tenant sem registrar abertura', async () => {
  let history = 0;
  const handler = createWhatsAppOpenedHandler({
    getLeadById: async () => null,
    recordWhatsAppOpened: async () => { history += 1; },
  });
  const invalid = responseMock();
  await handler(requestMock({ id: 'invalido' }), invalid);
  assert.equal(invalid.statusCode, 404);

  const missing = responseMock();
  await handler(requestMock(), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(history, 0);
});

test('falha do logging é sanitizada e não afeta a rota de compatibilidade', async () => {
  const handler = createWhatsAppOpenedHandler({
    getLeadById: async () => ({ id: LEAD_ID, tenant_id: 'tenant-a' }),
    recordWhatsAppOpened: async () => { throw new Error('detalhe interno'); },
  });
  const response = responseMock();
  await handler(requestMock(), response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body, 'Não foi possível registrar a abertura.');
});
