import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function classListMock() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force === false) values.delete(name);
      else values.add(name);
    },
    add(name) {
      values.add(name);
    },
    remove(name) {
      values.delete(name);
    },
    contains(name) {
      return values.has(name);
    },
  };
}

function createHarness({ popup = {}, fetchImpl } = {}) {
  const listeners = {};
  const attributes = new Map([['hidden', '']]);
  const label = { textContent: 'Abrir no WhatsApp' };
  const button = {
    disabled: false,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    querySelector(selector) {
      return selector === '[data-button-label]' ? label : null;
    },
  };
  const fallback = {
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const status = {
    textContent: '',
    classList: classListMock(),
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const form = {
    action: 'https://crm.example/leads/11111111-1111-4111-8111-111111111111/whatsapp',
    classList: classListMock(),
    attributes: {},
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector(selector) {
      return {
        '[data-whatsapp-submit]': button,
        '[data-whatsapp-fallback]': fallback,
        '[data-whatsapp-status]': status,
      }[selector] || null;
    },
  };
  let openCalls = 0;
  let fetchCalls = 0;
  const document = {
    querySelectorAll(selector) {
      return selector === '[data-whatsapp-form]' ? [form] : [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
  };
  const context = {
    document,
    FormData: class {},
    Error,
    URL,
    window: {
      open() {
        openCalls += 1;
        return popup;
      },
      setTimeout() {},
    },
    async fetch(...args) {
      fetchCalls += 1;
      return fetchImpl(...args);
    },
  };
  vm.runInNewContext(source, context);
  return {
    button,
    fallback,
    form,
    get fetchCalls() {
      return fetchCalls;
    },
    label,
    listeners,
    get openCalls() {
      return openCalls;
    },
    status,
    fallbackIsHidden: () => attributes.has('hidden'),
  };
}

function submitEvent(submitter) {
  return {
    submitter,
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
}

test('popup bloqueado não envia POST e oferece abertura na mesma aba', async () => {
  const harness = createHarness({
    popup: null,
    fetchImpl: async () => {
      throw new Error('fetch não deveria executar');
    },
  });
  await harness.listeners.submit(submitEvent(harness.button));

  assert.equal(harness.fetchCalls, 0);
  assert.equal(harness.fallbackIsHidden(), false);
  assert.match(harness.status.textContent, /bloqueada/);
  assert.equal(harness.status.role, 'alert');
});

test('popup permitido navega somente para redirectUrl wa.me válido', async () => {
  let redirectedTo = '';
  const popup = {
    closed: false,
    location: {
      replace(value) {
        redirectedTo = value;
      },
    },
  };
  const harness = createHarness({
    popup,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, redirectUrl: 'https://wa.me/5538991142298' }),
    }),
  });
  await harness.listeners.submit(submitEvent(harness.button));

  assert.equal(harness.fetchCalls, 1);
  assert.equal(redirectedTo, 'https://wa.me/5538991142298');
  assert.equal(popup.opener, null);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.label.textContent, 'Abrir no WhatsApp');
});

test('erro fecha popup, restaura botão, foco e mensagem contextual', async () => {
  let closed = false;
  const harness = createHarness({
    popup: {
      closed: false,
      close() {
        closed = true;
      },
      location: { replace() {} },
    },
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({
        ok: false,
        error: { message: 'O telefone deste lead é inválido.' },
      }),
    }),
  });
  await harness.listeners.submit(submitEvent(harness.button));

  assert.equal(closed, true);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.focusCount, 1);
  assert.equal(harness.status.role, 'alert');
  assert.match(harness.status.textContent, /telefone/);
});

test('duplo envio durante loading cria um popup e um request', async () => {
  let resolveFetch;
  const pendingFetch = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const harness = createHarness({
    popup: { closed: false, location: { replace() {} } },
    fetchImpl: () => pendingFetch,
  });
  const first = harness.listeners.submit(submitEvent(harness.button));
  const second = harness.listeners.submit(submitEvent(harness.button));

  assert.equal(harness.openCalls, 1);
  assert.equal(harness.fetchCalls, 1);
  resolveFetch({
    ok: true,
    json: async () => ({ ok: true, redirectUrl: 'https://wa.me/5538991142298' }),
  });
  await Promise.all([first, second]);
});

test('domínio diferente de wa.me é rejeitado e popup é fechado', async () => {
  let closed = false;
  let redirected = false;
  const harness = createHarness({
    popup: {
      closed: false,
      close() {
        closed = true;
      },
      location: {
        replace() {
          redirected = true;
        },
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, redirectUrl: 'https://example.com/' }),
    }),
  });
  await harness.listeners.submit(submitEvent(harness.button));

  assert.equal(redirected, false);
  assert.equal(closed, true);
  assert.equal(harness.status.role, 'alert');
});

test('HTTP, subdomínio malicioso e URL que apenas contém wa.me são rejeitados', async () => {
  for (const redirectUrl of [
    'http://wa.me/5538991142298',
    'https://wa.me.evil.example/5538991142298',
    'https://example.com/https://wa.me/5538991142298',
  ]) {
    let redirected = false;
    const harness = createHarness({
      popup: {
        closed: false,
        close() {},
        location: {
          replace() {
            redirected = true;
          },
        },
      },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ok: true, redirectUrl }),
      }),
    });
    await harness.listeners.submit(submitEvent(harness.button));
    assert.equal(redirected, false);
    assert.equal(harness.status.role, 'alert');
  }
});
