import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  authenticateWebsiteRequest,
  createWebsiteRateLimiter,
  decideWebsiteSubmission,
  hashWebsitePayload,
  isValidWebsiteIdempotencyKey,
  normalizeWebsiteLeadPayload,
  stableWebsiteJson,
  websiteEventId,
  websiteIngestConfig,
  websiteSignature,
  WEBSITE_EXTERNAL_SYSTEM,
  WEBSITE_INTEGRATION,
  WEBSITE_SOURCE,
  technicalWebsiteLeadName,
  websiteIdempotencyKey,
} from '../src/website-lead-ingest.js';

const SECRET = 'website-test-secret-0123456789-abcdef';
const ENV = {
  SUPEREDUCAR_WEBSITE_INGEST_ENABLED: 'true',
  SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET: SECRET,
  SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID: 'super-educar',
  SUPEREDUCAR_WEBSITE_INGEST_CLOCK_SKEW_SECONDS: '300',
};
const BASE_PAYLOAD = {
  external_lead_id: '  site-123  ',
  interest: 'Medicina Veterinária',
  phone: '+55 38 9 9999-9999',
  submitted_at: '2026-08-06T16:50:00-03:00',
};

function signedHeaders(rawBody, { timestamp = 1_754_500_000, nonce = 'nonce-unique-1' } = {}) {
  return {
    'X-SE-Integration': WEBSITE_INTEGRATION,
    'X-SE-Timestamp': String(timestamp),
    'X-SE-Nonce': nonce,
    'X-SE-Signature': websiteSignature({ secret: SECRET, timestamp, nonce, rawBody }),
  };
}

test('feature flag e configuração são opt-in e não exigem segredo quando desativadas', () => {
  assert.equal(websiteIngestConfig({}).enabled, false);
  assert.equal(websiteIngestConfig({}).configured, false);
  assert.equal(websiteIngestConfig({
    SUPEREDUCAR_WEBSITE_INGEST_ENABLED: 'false',
    SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET: SECRET,
    SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID: 'super-educar',
  }).enabled, false);
  assert.deepEqual(
    websiteIngestConfig(ENV),
    { enabled: true, secret: SECRET, tenantId: 'super-educar', clockSkewSeconds: 300, configured: true },
  );
  assert.equal(websiteIngestConfig({ ...ENV, SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET: 'short' }).configured, false);
  assert.equal(websiteIngestConfig({ ...ENV, SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID: '' }).configured, false);
});

test('payload mínimo normaliza telefone, instante e gera event ID sem telefone', () => {
  const normalized = normalizeWebsiteLeadPayload(BASE_PAYLOAD);
  assert.equal(normalized.externalLeadId, 'site-123');
  assert.equal(normalized.phoneNormalized, '5538999999999');
  assert.equal(normalized.submittedAt, '2026-08-06T19:50:00.000Z');
  assert.equal(normalized.websiteEventId, 'web:lead:supereducar:site-123');
  assert.equal(normalized.websiteSubmissionId, null);
  assert.equal(normalized.name, null);
  assert.equal(normalized.nameIsPlaceholder, true);
  assert.equal(normalized.nameSource, 'TECHNICAL_PLACEHOLDER');
  assert.equal(normalized.email, null);
  assert.doesNotMatch(normalized.websiteEventId, /5538999999999/);
  assert.equal(WEBSITE_SOURCE, 'WEBSITE_FORM');
});

test('payload completo preserva dados permitidos e cria event ID determinístico por submission', () => {
  const submissionId = '550e8400-e29b-41d4-a716-446655440000';
  const normalized = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    website_submission_id: submissionId.toUpperCase(),
    course_id: 'MEDICINA_VETERINARIA',
    course_name: 'Medicina Veterinária',
    modality: 'Semipresencial',
    name: 'Pessoa de Teste',
    email: 'teste@example.com',
    fbclid: 'fbclid-value',
    fbp: 'fbp-value',
    fbc: 'fbc-value',
    utm_source: 'meta',
    utm_medium: 'paid',
    utm_campaign: 'campaign',
    utm_content: 'ad',
    utm_term: 'term',
    campaign_id: 'campaign-id',
    adset_id: 'adset-id',
    ad_id: 'ad-id',
    landing_page_url: 'https://supereducar.com/',
    referrer_url: 'https://www.google.com/search?q=curso',
    consent_at: '2026-08-06T16:50:00-03:00',
  });
  assert.equal(normalized.websiteSubmissionId, submissionId.toLowerCase());
  assert.equal(normalized.websiteEventId, `web:lead:${submissionId.toLowerCase()}`);
  assert.equal(normalized.attribution.utm_campaign, 'campaign');
  assert.equal(normalized.attribution.landing_page_url, 'https://supereducar.com/');
  assert.equal(normalized.attribution.consent_at, '2026-08-06T19:50:00.000Z');
  assert.equal(normalized.attribution.provider, 'meta');
  assert.deepEqual(normalized.attribution.click_ids, {
    fbclid: 'fbclid-value',
    fbp: 'fbp-value',
    fbc: 'fbc-value',
  });
  assert.equal(normalized.phone, BASE_PAYLOAD.phone);
  assert.equal(normalized.nameIsPlaceholder, false);
  assert.equal(normalized.nameSource, 'USER_PROVIDED');
});

test('atribuição universal normaliza Meta e preserva campos extensíveis', () => {
  const normalized = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: {
      provider: ' Google ',
      source: ' Google ',
      medium: ' CPC ',
      channel: ' Paid_Search ',
      campaign_id: 'campaign-123',
      campaign_name: 'Campanha',
      ad_group_id: 'group-456',
      ad_group_name: 'Grupo',
      ad_id: 'ad-789',
      ad_name: 'Anúncio',
      keyword: 'veterinária',
      match_type: 'Exact',
      click_ids: { gclid: 'gclid-value', gbraid: 'gbraid-value', wbraid: 'wbraid-value' },
      extra: { landing_variant: 'A', score: 1, qualified: true, note: null },
    },
  });
  assert.equal(normalized.attribution.provider, 'google');
  assert.equal(normalized.attribution.source, 'google');
  assert.equal(normalized.attribution.medium, 'cpc');
  assert.equal(normalized.attribution.channel, 'paid_search');
  assert.equal(normalized.attribution.match_type, 'exact');
  assert.deepEqual(normalized.attribution.click_ids, {
    gclid: 'gclid-value',
    gbraid: 'gbraid-value',
    wbraid: 'wbraid-value',
  });
  assert.deepEqual(normalized.attribution.extra, {
    landing_variant: 'A', score: 1, qualified: true, note: null,
  });
});

test('providers e click IDs de plataformas conhecidas e futuras não exigem migration', () => {
  const cases = [
    ['google', 'gclid'], ['google', 'gbraid'], ['google', 'wbraid'],
    ['tiktok', 'ttclid'], ['microsoft', 'msclkid'], ['future_network', 'future_click_id'],
  ];
  for (const [provider, clickId] of cases) {
    const normalized = normalizeWebsiteLeadPayload({
      ...BASE_PAYLOAD,
      external_lead_id: `site-${provider}-${clickId}`,
      attribution: { provider, click_ids: { [clickId]: 'click-value' } },
    });
    assert.equal(normalized.attribution.provider, provider);
    assert.equal(normalized.attribution.click_ids[clickId], 'click-value');
  }
});

test('origens orgânica, direta e referral preservam a classificação enviada', () => {
  const cases = [
    { provider: 'organic', source: 'google', medium: 'organic', channel: 'organic' },
    { provider: 'direct', source: 'direct', medium: 'none', channel: 'direct' },
    { provider: 'referral', source: 'parceiro.example', medium: 'referral', channel: 'referral' },
  ];
  for (const [index, attribution] of cases.entries()) {
    const normalized = normalizeWebsiteLeadPayload({
      ...BASE_PAYLOAD,
      external_lead_id: `site-origin-${index}`,
      attribution,
    });
    assert.deepEqual(normalized.attribution, attribution);
  }
});

test('attribution novo tem precedência determinística e rejeita contradição legada', () => {
  const legacy = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    fbclid: 'same-click',
    utm_source: 'facebook',
    utm_medium: 'paid_social',
  });
  const equivalent = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: {
      provider: 'meta',
      source: 'facebook',
      medium: 'paid_social',
      click_ids: { fbclid: 'same-click' },
    },
  });
  assert.equal(equivalent.payloadHash, legacy.payloadHash);
  assert.throws(
    () => normalizeWebsiteLeadPayload({
      ...BASE_PAYLOAD,
      utm_source: 'facebook',
      attribution: { source: 'google' },
    }),
    { code: 'ATTRIBUTION_CONFLICT' },
  );
});

test('legacy e universal convergem para o mesmo hash canônico', () => {
  const cases = [
    [
      { fbclid: 'fb-click' },
      { attribution: { provider: 'meta', click_ids: { fbclid: 'fb-click' } } },
    ],
    [
      { fbp: 'fb-browser' },
      { attribution: { provider: 'meta', click_ids: { fbp: 'fb-browser' } } },
    ],
    [
      { fbc: 'fb-campaign' },
      { attribution: { provider: 'meta', click_ids: { fbc: 'fb-campaign' } } },
    ],
    [
      { utm_source: 'facebook' },
      { attribution: { provider: 'meta', source: 'facebook', utm_source: 'facebook' } },
    ],
    [
      { utm_source: ' FACEBOOK ', utm_medium: ' PAID_SOCIAL ' },
      { attribution: { provider: 'meta', source: 'facebook', medium: 'paid_social' } },
    ],
    [
      { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'campaign' },
      { attribution: { provider: 'google', source: 'google', medium: 'cpc', utm_campaign: 'campaign' } },
    ],
    [
      { campaign_id: 'campaign-id' },
      { attribution: { campaign_id: 'campaign-id' } },
    ],
    [
      { adset_id: 'adset-id' },
      { attribution: { adset_id: 'adset-id' } },
    ],
    [
      { ad_id: 'ad-id' },
      { attribution: { ad_id: 'ad-id' } },
    ],
    [
      {
        utm_content: 'content', utm_term: 'term',
        landing_page_url: 'https://supereducar.com/landing',
        referrer_url: 'https://google.com/',
      },
      {
        attribution: {
          utm_content: 'content', utm_term: 'term',
          landing_page_url: 'https://supereducar.com/landing',
          referrer_url: 'https://google.com/',
        },
      },
    ],
  ];
  for (const [legacyFields, universalFields] of cases) {
    const legacy = normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, ...legacyFields });
    const universal = normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, ...universalFields });
    assert.deepEqual(universal.attribution, legacy.attribution);
    assert.equal(universal.payloadHash, legacy.payloadHash);
  }
});

test('replay legacy/universal equivalente é idempotente nos dois sentidos', () => {
  const legacy = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    external_lead_id: 'replay-equivalent',
    utm_source: 'facebook',
    fbclid: 'replay-click',
  });
  const universal = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    external_lead_id: 'replay-equivalent',
    attribution: {
      provider: 'meta',
      source: 'facebook',
      click_ids: { fbclid: 'replay-click' },
    },
  });
  const legacyRecord = {
    payload_hash: legacy.payloadHash,
    lead_id: 'lead-replay',
    website_event_id: legacy.websiteEventId,
  };
  const universalRecord = {
    payload_hash: universal.payloadHash,
    lead_id: 'lead-replay',
    website_event_id: universal.websiteEventId,
  };
  assert.equal(decideWebsiteSubmission(legacyRecord, universal).code, 'IDEMPOTENT_REPLAY');
  assert.equal(decideWebsiteSubmission(universalRecord, legacy).code, 'IDEMPOTENT_REPLAY');
});

test('enriquecimento posterior com novo click ID continua bloqueado na V1', () => {
  const first = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    external_lead_id: 'replay-enrichment',
    utm_source: 'google',
  });
  const second = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    external_lead_id: 'replay-enrichment',
    attribution: {
      provider: 'google',
      source: 'google',
      click_ids: { gclid: 'new-gclid' },
    },
  });
  const decision = decideWebsiteSubmission({
    payload_hash: first.payloadHash,
    lead_id: 'lead-enrichment',
    website_event_id: first.websiteEventId,
  }, second);
  assert.equal(decision.code, 'EXTERNAL_ID_CONFLICT');
  assert.notEqual(first.payloadHash, second.payloadHash);
  assert.deepEqual(first.attribution, { provider: 'google', source: 'google' });
});

test('extra e click_ids rejeitam estruturas inseguras, limites e prototype pollution', () => {
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { click_ids: { gclid: ['not-string'] } },
  }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { extra: { nested: { value: true } } },
  }), { code: 'INVALID_PAYLOAD' });
  const pollutedClickIds = JSON.parse('{"__proto__":"blocked"}');
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { click_ids: pollutedClickIds },
  }), { code: 'INVALID_PAYLOAD' });
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { extra: polluted },
  }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { extra: Object.fromEntries(Array.from({ length: 31 }, (_unused, index) => [`k${index}`, true])) },
  }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    attribution: { extra: Object.fromEntries(Array.from({ length: 9 }, (_unused, index) => [`k${index}`, 'x'.repeat(1000)])) },
  }), { code: 'INVALID_PAYLOAD' });
});

test('nome ausente usa placeholder técnico e nome informado é preservado', () => {
  assert.equal(technicalWebsiteLeadName('qualquer-id'), 'Sem nome — site');
  const normalized = normalizeWebsiteLeadPayload({
    ...BASE_PAYLOAD,
    name: 'Pessoa de Teste',
  });
  assert.equal(normalized.name, 'Pessoa de Teste');
  assert.equal(normalized.nameIsPlaceholder, false);
  assert.equal(normalized.nameSource, 'USER_PROVIDED');
  assert.throws(
    () => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, external_lead_id: 'site\n123' }),
    { code: 'INVALID_PAYLOAD' },
  );
});

test('Idempotency-Key é obrigatória, única e corresponde exatamente ao external_lead_id', () => {
  assert.equal(websiteIdempotencyKey('site-123'), 'supereducar:site-123');
  assert.equal(isValidWebsiteIdempotencyKey('supereducar:site-123', 'site-123'), true);
  assert.equal(isValidWebsiteIdempotencyKey('', 'site-123'), false);
  assert.equal(isValidWebsiteIdempotencyKey('supereducar:outro', 'site-123'), false);
  assert.equal(isValidWebsiteIdempotencyKey('supereducar:site-123,supereducar:site-123', 'site-123'), false);
  assert.equal(isValidWebsiteIdempotencyKey(`supereducar:${'x'.repeat(321)}`, 'x'.repeat(321)), false);
  assert.equal(isValidWebsiteIdempotencyKey('supereducar:site\n123', 'site\n123'), false);
});

test('validação rejeita campos capazes de alterar tenant, funil ou Meta', () => {
  for (const field of ['tenant_id', 'source', 'stage', 'dataset_id', 'event_name', 'mql_status', 'payment_status', 'ip']) {
    assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, [field]: 'forbidden' }), { code: 'INVALID_PAYLOAD' });
  }
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, external_lead_id: '' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, external_lead_id: {} }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, interest: null }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, phone: 'not-a-phone' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, submitted_at: 'invalid' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, website_submission_id: 'not-uuid' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, email: 'not-email' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, landing_page_url: 'ftp://example.com' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, name: { value: 'x' } }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, interest: 'x'.repeat(201) }), { code: 'INVALID_PAYLOAD' });
});

test('hash semântico ignora ordem de chaves, whitespace e vazio versus null', () => {
  const first = normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, name: '', email: null });
  const second = normalizeWebsiteLeadPayload({
    submitted_at: '2026-08-06T19:50:00.000Z',
    phone: '5538999999999',
    interest: 'Medicina Veterinária',
    external_lead_id: 'site-123',
    name: null,
  });
  assert.equal(first.payloadHash, second.payloadHash);
  assert.equal(hashWebsitePayload({ b: 2, a: 1 }), hashWebsitePayload({ a: 1, b: 2 }));
  assert.equal(stableWebsiteJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.notEqual(
    normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, interest: 'Outro curso' }).payloadHash,
    first.payloadHash,
  );
  assert.notEqual(
    normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, phone: '+55 31 9 9999-9999' }).payloadHash,
    first.payloadHash,
  );
});

test('IDs são determinísticos, independentes de nome e telefone', () => {
  assert.equal(websiteEventId({ externalLeadId: 'abc', websiteSubmissionId: null }), 'web:lead:supereducar:abc');
  assert.equal(websiteEventId({ externalLeadId: 'abc', websiteSubmissionId: 'id-1' }), 'web:lead:id-1');
  assert.doesNotMatch(websiteEventId({ externalLeadId: 'abc', websiteSubmissionId: null }), /phone|name/);
  const first = normalizeWebsiteLeadPayload(BASE_PAYLOAD);
  const retry = normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, name: 'Outro nome' });
  assert.notEqual(first.websiteEventId, 'web:lead:supereducar:' + first.phoneNormalized);
  assert.equal(first.websiteEventId, retry.websiteEventId);
});

test('HMAC usa raw body exato, timestamp, nonce e integração lógica', () => {
  const rawBody = Buffer.from('{"external_lead_id":"site-123","interest":"Curso","phone":"5538999999999","submitted_at":"2026-08-06T16:50:00-03:00"}', 'utf8');
  const timestamp = 1_754_500_000;
  const headers = signedHeaders(rawBody, { timestamp });
  assert.deepEqual(authenticateWebsiteRequest({ headers, rawBody, env: ENV, nowSeconds: timestamp }), {
    ok: true,
    timestamp,
    nonce: 'nonce-unique-1',
  });
  assert.equal(authenticateWebsiteRequest({
    headers,
    rawBody: Buffer.from(`${rawBody.toString()} `),
    env: ENV,
    nowSeconds: timestamp,
  }).code, 'INVALID_SIGNATURE');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, 'X-SE-Integration': 'other' }, rawBody, env: ENV, nowSeconds: timestamp,
  }).code, 'INVALID_INTEGRATION');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, 'X-SE-Signature': '' }, rawBody, env: ENV, nowSeconds: timestamp,
  }).code, 'INVALID_SIGNATURE');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, 'X-SE-Timestamp': String(timestamp - 301) }, rawBody, env: ENV, nowSeconds: timestamp,
  }).code, 'TIMESTAMP_OUT_OF_RANGE');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, 'X-SE-Timestamp': String(timestamp + 301) }, rawBody, env: ENV, nowSeconds: timestamp,
  }).code, 'TIMESTAMP_OUT_OF_RANGE');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, 'X-SE-Nonce': '' }, rawBody, env: ENV, nowSeconds: timestamp,
  }).code, 'INVALID_SIGNATURE');
});

test('fixture fixa da assinatura é compatível com a fórmula PHP hash_hmac', () => {
  const rawBody = Buffer.from('{"external_lead_id":"fixture-1","interest":"Curso","phone":"5538999999999","submitted_at":"2026-08-06T19:50:00.000Z"}', 'utf8');
  const timestamp = '1754500000';
  const nonce = 'fixture-nonce-0001';
  const phpEquivalent = `sha256=${crypto.createHmac('sha256', SECRET)
    .update(`${timestamp}\n${nonce}\n`)
    .update(rawBody)
    .digest('hex')}`;
  assert.equal(websiteSignature({ secret: SECRET, timestamp, nonce, rawBody }), phpEquivalent);
  assert.deepEqual(
    authenticateWebsiteRequest({
      headers: {
        ...signedHeaders(rawBody, { timestamp: Number(timestamp), nonce }),
        'X-SE-Signature': phpEquivalent,
      },
      rawBody,
      env: ENV,
      nowSeconds: Number(timestamp),
    }),
    { ok: true, timestamp: Number(timestamp), nonce },
  );
});

test('HMAC não funciona sem secret/tenant configurados e não depende do hostname', () => {
  const rawBody = Buffer.from('{}');
  const headers = signedHeaders(rawBody);
  assert.equal(authenticateWebsiteRequest({ headers, rawBody, env: {}, nowSeconds: 1_754_500_000 }).code, 'WEBSITE_INGEST_NOT_CONFIGURED');
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, Host: 'qualquer-servidor-autorizado' }, rawBody, env: ENV, nowSeconds: 1_754_500_000,
  }).ok, true);
});

test('nonce é somente header autenticado e o rate limit é exclusivo da integração', () => {
  const limiter = createWebsiteRateLimiter({ limit: 60, now: (() => { let value = 1_000; return () => value; })() });
  for (let count = 0; count < 60; count += 1) assert.equal(limiter.allow(WEBSITE_EXTERNAL_SYSTEM).allowed, true);
  assert.equal(limiter.allow(WEBSITE_EXTERNAL_SYSTEM).allowed, false);
  assert.equal(limiter.allow('OTHER_INTEGRATION').allowed, true);
  assert.equal(limiter.allow(WEBSITE_EXTERNAL_SYSTEM).retryAfter > 0, true);
  limiter.clear();
  assert.equal(limiter.allow(WEBSITE_EXTERNAL_SYSTEM).allowed, true);
});

test('decisão de persistência é criada, idempotente ou conflito sem merge por telefone', () => {
  const incoming = { payloadHash: 'a'.repeat(64), websiteEventId: 'web:lead:supereducar:1' };
  assert.deepEqual(decideWebsiteSubmission(null, incoming), { code: 'CREATED', created: true });
  assert.deepEqual(decideWebsiteSubmission({
    payload_hash: incoming.payloadHash,
    lead_id: 'lead-1',
    website_event_id: incoming.websiteEventId,
  }, incoming), {
    code: 'IDEMPOTENT_REPLAY',
    created: false,
    leadId: 'lead-1',
    websiteEventId: incoming.websiteEventId,
  });
  assert.equal(decideWebsiteSubmission({ payload_hash: 'b'.repeat(64) }, incoming).code, 'EXTERNAL_ID_CONFLICT');
});

test('contrato implementado usa migration aditiva, rota antes do parser global e não aciona Meta/WA2', async () => {
  const [migration, server, db, docs, envExample, stack] = await Promise.all([
    readFile(new URL('../sql/022_website_lead_ingest.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/db.js', import.meta.url), 'utf8'),
    readFile(new URL('../docs/SUPEREDUCAR_WEBSITE_INGEST.md', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../docker-stack.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS website_lead_submissions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS website_lead_ingest_nonces/);
  assert.match(migration, /UNIQUE \(tenant_id, external_system, external_lead_id\)/);
  assert.match(migration, /website_lead_submissions_submission_uidx/);
  assert.match(migration, /name_is_placeholder BOOLEAN NOT NULL/);
  assert.match(migration, /name_source TEXT NOT NULL/);
  assert.doesNotMatch(migration, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|UPDATE\s+/i);
  const routeAt = server.indexOf('WEBSITE_INGEST_ROUTE');
  const globalJsonAt = server.indexOf('app.use(express.json');
  assert.ok(routeAt >= 0 && routeAt < globalJsonAt);
  assert.match(server, /express\.raw\(\{ type: 'application\/json', limit: '32kb' \}\)/);
  assert.match(server, /WEBSITE_INGEST_DISABLED/);
  assert.match(server, /createWebsiteLeadSubmission/);
  const websiteDbFunction = db.slice(
    db.indexOf('export async function createWebsiteLeadSubmission'),
    db.indexOf('function serializeJsonb'),
  );
  assert.match(websiteDbFunction, /pg_advisory_xact_lock/);
  assert.match(websiteDbFunction, /website_lead_ingest_nonces/);
  assert.match(websiteDbFunction, /LIMIT 100/);
  assert.match(websiteDbFunction, /source_created_at/);
  assert.match(websiteDbFunction, /'NEW'/);
  assert.doesNotMatch(websiteDbFunction, /meta_conversion_events|meta_jobs|wa2_contact_links|fetch\(|Graph/i);
  assert.match(docs, /Pixel Web e eventual CAPI Web futura/);
  assert.match(docs, /1414255997275699/);
  assert.match(docs, /1059632093187676/);
  assert.match(docs, /775516968145969/);
  assert.match(docs, /Atribuição universal/);
  assert.match(docs, /Google Ads/);
  assert.match(docs, /click_ids/);
  assert.match(docs, /ATTRIBUTION_CONFLICT/);
  assert.match(docs, /não pertence[\s\S]*exclusivamente à Meta/);
  assert.match(docs, /name_is_placeholder=true/);
  assert.match(docs, /Idempotency-Key.*obrigatória/);
  assert.match(docs, /não deve ser[\s\S]*executado no navegador/);
  assert.match(envExample, /SUPEREDUCAR_WEBSITE_INGEST_ENABLED=false/);
  assert.match(envExample, /SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID=\r?\n/);
  assert.match(stack, /SUPEREDUCAR_WEBSITE_INGEST_ENABLED/);
  assert.doesNotMatch(server.slice(server.indexOf('async function receiveWebsiteLead'), server.indexOf("app.get('/health'")), /fetch\(|axios|meta_conversion_events|meta_jobs|wa2_contact_links|Graph/i);
});

test('WEBSITE_FORM não altera os defaults de META_INSTANT_FORM', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  if (!previousDatabaseUrl) process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  const { upsertLead } = await import(`../src/db.js?meta-regression=${Date.now()}`);
  if (!previousDatabaseUrl) delete process.env.DATABASE_URL;
  const queries = [];
  const fakeClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO leads')) {
        return { rows: [{ source: params[7], stage: params[8], was_inserted: false }] };
      }
      return { rows: [] };
    },
  };
  const lead = await upsertLead({
    tenantId: 'website-meta-regression',
    metaLeadId: 'meta-regression-lead',
    name: 'Lead Meta de teste',
    phone: '+55 38 9 9999-9999',
  }, { client: fakeClient });
  assert.equal(lead.source, 'META_INSTANT_FORM');
  assert.equal(lead.stage, 'NEW');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].params[7], 'META_INSTANT_FORM');
  assert.equal(queries[0].params[8], 'NEW');
});

test('identidade lógica não depende de domínio, origem, IP ou hostname', () => {
  assert.equal(WEBSITE_INTEGRATION, 'supereducar-website');
  assert.equal(WEBSITE_EXTERNAL_SYSTEM, 'SUPEREDUCAR_WEBSITE');
  const rawBody = Buffer.from('{}');
  const timestamp = 1_754_500_000;
  const headers = signedHeaders(rawBody, { timestamp });
  assert.equal(authenticateWebsiteRequest({
    headers: { ...headers, Origin: 'https://outro-host.example', Referer: 'https://outro-host.example' },
    rawBody,
    env: ENV,
    nowSeconds: timestamp,
  }).ok, true);
});

test('campos comerciais relevantes mudam o hash e campos opcionais nulos são preservados sem payload bruto', () => {
  const normalized = normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, course_id: 'A', email: '' });
  assert.equal(normalized.email, null);
  assert.equal(normalized.hashInput.phone, normalized.phoneNormalized);
  assert.equal(Object.hasOwn(normalized, 'rawBody'), false);
  assert.notEqual(
    normalizeWebsiteLeadPayload({ ...BASE_PAYLOAD, course_id: 'B' }).payloadHash,
    normalized.payloadHash,
  );
});

test('assinatura esperada é SHA-256 hexadecimal e nunca contém o segredo', () => {
  const rawBody = Buffer.from('{}');
  const signature = websiteSignature({ secret: SECRET, timestamp: '1', nonce: 'n', rawBody });
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.doesNotMatch(signature, new RegExp(SECRET));
  assert.equal(crypto.createHash('sha256').update('1\nn\n{}').digest('hex').length, 64);
});
