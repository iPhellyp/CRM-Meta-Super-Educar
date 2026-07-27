import assert from 'node:assert/strict';
import test from 'node:test';
import { createWa2Client, Wa2Error } from '../src/wa2.js';

const env = {
  NODE_ENV: 'test',
  WA2_INTERNAL_API_BASE_URL: 'http://localhost:3000',
  WA2_INTERNAL_API_SECRET: 'test-secret',
  WA2_INTERNAL_API_TIMEOUT_MS: '1000',
};

function event(overrides = {}) {
  return {
    eventId: '00000000-0000-4000-8000-000000000001',
    instanceId: 'instance-1',
    chatId: 'chat-1',
    jid: '5511987654321@s.whatsapp.net',
    phoneNormalized: '5511987654321',
    waLabelId: '10',
    operation: 'APPLY',
    source: 'WHATSAPP',
    observedAt: '2026-07-27T12:00:00.000Z',
    eligibleForCrm: true,
    ineligibleReason: null,
    secret: 'discard-me',
    ...overrides,
  };
}

test('lista feed incremental com Bearer, Request ID, cursor e limite', async () => {
  let request;
  const client = createWa2Client({
    env,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        events: [event()],
        nextCursor: 'djE6MQ',
        hasMore: true,
      }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const page = await client.listLabelEvents({ after: 'djE6MA', limit: 25 });
  assert.match(request.url, /label-events\?limit=25&after=djE6MA$/);
  assert.equal(request.options.headers.authorization, 'Bearer test-secret');
  assert.equal(request.options.headers['x-request-id'], '11111111-1111-4111-8111-111111111111');
  assert.equal(request.options.redirect, 'error');
  assert.equal(page.events[0].secret, undefined);
  assert.equal(page.nextCursor, 'djE6MQ');
  assert.equal(page.hasMore, true);
});

test('evento individual divergente e paginação inválida são rejeitados', async () => {
  let calls = 0;
  const client = createWa2Client({
    env,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        events: [event({ jid: '123@g.us' })],
        nextCursor: null,
        hasMore: false,
      }));
    },
  });
  await assert.rejects(
    client.listLabelEvents({ limit: 100 }),
    (error) => error instanceof Wa2Error && error.code === 'WA2_LABEL_EVENT_INVALID',
  );
  assert.throws(
    () => client.listLabelEvents({ after: '../unsafe', limit: 100 }),
    (error) => error instanceof Wa2Error && error.code === 'WA2_LABEL_EVENTS_PAGE_INVALID',
  );
  assert.equal(calls, 1);
});

test('grupo não elegível é preservado de forma sanitizada', async () => {
  const client = createWa2Client({
    env,
    fetchImpl: async () => new Response(JSON.stringify({
      events: [event({
        jid: '123@g.us',
        phoneNormalized: null,
        eligibleForCrm: false,
        ineligibleReason: 'GROUP',
      })],
      nextCursor: null,
      hasMore: false,
    })),
  });
  const page = await client.listLabelEvents();
  assert.equal(page.events[0].eligibleForCrm, false);
  assert.equal(page.events[0].ineligibleReason, 'GROUP');
});

test('LID resolvido indicado pelo WA2 é aceito sem inventar JID de telefone', async () => {
  const client = createWa2Client({
    env,
    fetchImpl: async () => new Response(JSON.stringify({
      events: [event({ jid: '123@lid' })],
      nextCursor: null,
      hasMore: false,
    })),
  });
  const page = await client.listLabelEvents();
  assert.equal(page.events[0].jid, '123@lid');
  assert.equal(page.events[0].phoneNormalized, '5511987654321');
});
