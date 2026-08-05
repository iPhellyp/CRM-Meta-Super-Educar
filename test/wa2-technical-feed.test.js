import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLabelEvent, sanitizeLabelEvents } from '../src/wa2.js';

const base = {
  eventId: '11111111-1111-4111-8111-111111111111',
  instanceId: '2298-univc-1785528349941',
  chatId: 'chat-1',
  waLabelId: '57',
  waLabelName: 'CRM 01',
  operation: 'APPLY',
  source: 'WHATSAPP',
  observedAt: '2026-08-05T22:00:00.000Z',
  eligibleForCrm: true,
};

test('classifica telefone WA2 inválido sem bloquear o evento', () => {
  const event = sanitizeLabelEvent({
    ...base,
    phoneNormalized: 'telefone-invalido',
    jid: '123@lid',
  });
  assert.equal(event.eligibleForCrm, false);
  assert.equal(event.ineligibleReason, 'INVALID_PHONE_FORMAT');
});

test('LID sem PN vira pendência técnica e grupo é ignorado', () => {
  const lid = sanitizeLabelEvent({ ...base, jid: '123@lid' });
  const group = sanitizeLabelEvent({ ...base, eventId: '22222222-2222-4222-8222-222222222222', jid: '123@g.us' });
  assert.equal(lid.ineligibleReason, 'LID_WITHOUT_PN');
  assert.equal(group.ineligibleReason, 'NON_INDIVIDUAL_JID');
  assert.equal(group.eligibleForCrm, false);
});

test('evento posterior válido continua sendo sanitizado e registro malformado é isolado', () => {
  const page = sanitizeLabelEvents({
    events: [
      null,
      { ...base, eventId: '33333333-3333-4333-8333-333333333333', jid: '5538999999999@s.whatsapp.net', phoneNormalized: '5538999999999' },
    ],
    nextCursor: 'cursor-2',
    hasMore: false,
  });
  assert.deepEqual(page.events[0], { technicalOnly: true, technicalReason: 'MALFORMED_HISTORICAL_RECORD' });
  assert.equal(page.events[1].eligibleForCrm, true);
});
