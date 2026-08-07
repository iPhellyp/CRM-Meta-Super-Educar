import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { normalizeWebsiteLeadPayload } from '../src/website-lead-ingest.js';

const url = process.env.TEST_DATABASE_URL;

test('WEBSITE_FORM cria uma vez, é idempotente, tenant-safe e não aciona Meta/WA2', {
  skip: !url,
  timeout: 120_000,
}, async (t) => {
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = 'false';
  process.env.DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || `website-test-${process.pid}`;
  const {
    createWebsiteLeadSubmission,
    migrate,
    pool,
  } = await import(`../src/db.js?website-integration=${Date.now()}`);
  const tenant = process.env.DEFAULT_TENANT_ID;
  const otherTenant = `${tenant}-other`;
  const tenants = [tenant, otherTenant];

  async function cleanup() {
    for (const currentTenant of tenants) {
      await pool.query('DELETE FROM website_lead_submissions WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM website_lead_ingest_nonces WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM lead_verified_whatsapp_identities WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM wa2_contact_links WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM lead_stage_history WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM meta_conversion_events WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM meta_jobs WHERE tenant_id=$1', [currentTenant]);
      await pool.query('DELETE FROM leads WHERE tenant_id=$1', [currentTenant]);
    }
  }

  await migrate();
  await cleanup();
  t.after(async () => {
    try { await cleanup(); } finally { await pool.end(); }
  });

  const normalized = normalizeWebsiteLeadPayload({
    external_lead_id: 'website-integration-1',
    interest: 'Medicina Veterinária',
    phone: '+55 38 9 9999-9999',
    submitted_at: '2026-08-06T16:50:00-03:00',
    attribution: {
      provider: 'google',
      source: 'google',
      medium: 'cpc',
      channel: 'paid_search',
      click_ids: { gclid: 'postgres-gclid' },
      extra: { test_mode: true },
    },
  });
  const makeInput = (currentTenant, nonce) => ({
    ...normalized,
    tenantId: currentTenant,
    nonceHash: crypto.createHash('sha256').update(nonce).digest('hex'),
    nonceExpiresAt: new Date(Date.now() + 300_000),
  });

  const first = await createWebsiteLeadSubmission(makeInput(tenant, 'nonce-first'));
  assert.equal(first.created, true);
  assert.equal(first.code, 'CREATED');
  assert.match(first.websiteEventId, /^web:lead:supereducar:/);

  const [createdLead, createdSubmission, createdHistory] = await Promise.all([
    pool.query('SELECT name FROM leads WHERE tenant_id=$1 AND id=$2', [tenant, first.leadId]),
    pool.query('SELECT name_is_placeholder, name_source, attribution_json FROM website_lead_submissions WHERE tenant_id=$1 AND lead_id=$2', [tenant, first.leadId]),
    pool.query("SELECT metadata FROM lead_stage_history WHERE tenant_id=$1 AND lead_id=$2 AND activity_type='LEAD_RECEIVED'", [tenant, first.leadId]),
  ]);
  assert.equal(createdLead.rows[0].name, 'Sem nome — site');
  assert.equal(createdSubmission.rows[0].name_is_placeholder, true);
  assert.equal(createdSubmission.rows[0].name_source, 'TECHNICAL_PLACEHOLDER');
  assert.deepEqual(createdSubmission.rows[0].attribution_json, normalized.attribution);
  assert.deepEqual(createdHistory.rows[0].metadata, {
    source: 'WEBSITE_FORM',
    nameIsPlaceholder: true,
    nameSource: 'TECHNICAL_PLACEHOLDER',
  });

  const replay = await createWebsiteLeadSubmission(makeInput(tenant, 'nonce-replay'));
  assert.deepEqual(replay, {
    created: false,
    code: 'IDEMPOTENT_REPLAY',
    leadId: first.leadId,
    websiteEventId: first.websiteEventId,
  });

  await assert.rejects(
    createWebsiteLeadSubmission({
      ...makeInput(tenant, 'nonce-conflict'),
      interest: 'Curso diferente',
      payloadHash: 'f'.repeat(64),
    }),
    (error) => error.code === 'EXTERNAL_ID_CONFLICT',
  );

  await assert.rejects(
    createWebsiteLeadSubmission(makeInput(tenant, 'nonce-first')),
    (error) => error.code === 'NONCE_REPLAY',
  );

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) => createWebsiteLeadSubmission(
      makeInput(tenant, `nonce-concurrent-${index}`),
    )),
  );
  assert.equal(concurrent.filter((result) => result.created).length, 0);
  assert.equal(concurrent.filter((result) => result.code === 'IDEMPOTENT_REPLAY').length, 8);

  const isolated = await createWebsiteLeadSubmission(makeInput(otherTenant, 'nonce-other-tenant'));
  assert.equal(isolated.created, true);
  assert.notEqual(isolated.leadId, first.leadId);

  const [submissions, leads, history, metaEvents, metaJobs, links, identities] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM website_lead_submissions WHERE tenant_id=$1', [tenant]),
    pool.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id=$1 AND source=$2 AND stage=$3', [tenant, 'WEBSITE_FORM', 'NEW']),
    pool.query("SELECT count(*)::int AS count FROM lead_stage_history WHERE tenant_id=$1 AND activity_type='LEAD_RECEIVED' AND origin='WEBSITE_FORM'", [tenant]),
    pool.query('SELECT count(*)::int AS count FROM meta_conversion_events WHERE tenant_id=$1', [tenant]),
    pool.query('SELECT count(*)::int AS count FROM meta_jobs WHERE tenant_id=$1', [tenant]),
    pool.query('SELECT count(*)::int AS count FROM wa2_contact_links WHERE tenant_id=$1', [tenant]),
    pool.query('SELECT count(*)::int AS count FROM lead_verified_whatsapp_identities WHERE tenant_id=$1', [tenant]),
  ]);
  assert.equal(submissions.rows[0].count, 1);
  assert.equal(leads.rows[0].count, 1);
  assert.equal(history.rows[0].count, 1);
  assert.equal(metaEvents.rows[0].count, 0);
  assert.equal(metaJobs.rows[0].count, 0);
  assert.equal(links.rows[0].count, 0);
  assert.equal(identities.rows[0].count, 0);
});

test('WEBSITE_FORM canonicaliza replay legacy/universal e não faz merge por telefone', {
  skip: !url,
  timeout: 120_000,
}, async (t) => {
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = 'false';
  process.env.DEFAULT_TENANT_ID = `website-regression-${process.pid}`;
  const {
    createWebsiteLeadSubmission,
    migrate,
    pool,
  } = await import(`../src/db.js?website-regression=${Date.now()}`);
  const tenant = process.env.DEFAULT_TENANT_ID;

  async function cleanup() {
    await pool.query('DELETE FROM website_lead_submissions WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM website_lead_ingest_nonces WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM lead_verified_whatsapp_identities WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM wa2_contact_links WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM lead_stage_history WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM meta_conversion_events WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM meta_jobs WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM leads WHERE tenant_id=$1', [tenant]);
  }

  await migrate();
  await cleanup();
  t.after(async () => {
    try { await cleanup(); } finally { await pool.end(); }
  });

  const makeInput = (payload, nonce) => ({
    ...normalizeWebsiteLeadPayload(payload),
    tenantId: tenant,
    nonceHash: crypto.createHash('sha256').update(nonce).digest('hex'),
    nonceExpiresAt: new Date(Date.now() + 300_000),
  });
  const common = {
    interest: 'Medicina Veterinária',
    phone: '+55 38 9 9999-9999',
    submitted_at: '2026-08-06T16:50:00-03:00',
  };

  const legacy = {
    ...common,
    external_lead_id: 'legacy-universal-replay',
    utm_source: 'facebook',
    fbclid: 'replay-click',
  };
  const universal = {
    ...common,
    external_lead_id: 'legacy-universal-replay',
    attribution: {
      provider: 'meta',
      source: 'facebook',
      click_ids: { fbclid: 'replay-click' },
    },
  };
  const first = await createWebsiteLeadSubmission(makeInput(legacy, 'legacy-first'));
  const replay = await createWebsiteLeadSubmission(makeInput(universal, 'universal-replay'));
  assert.equal(first.created, true);
  assert.equal(replay.code, 'IDEMPOTENT_REPLAY');
  assert.equal(replay.leadId, first.leadId);

  const leadA = await createWebsiteLeadSubmission(makeInput({
    ...common, external_lead_id: 'same-phone-a', interest: 'Curso A',
  }, 'same-phone-a'));
  const leadB = await createWebsiteLeadSubmission(makeInput({
    ...common, external_lead_id: 'same-phone-b', interest: 'Curso B',
  }, 'same-phone-b'));
  assert.equal(leadA.created, true);
  assert.equal(leadB.created, true);
  assert.notEqual(leadA.leadId, leadB.leadId);

  const enrichment = await createWebsiteLeadSubmission(makeInput({
    ...common,
    external_lead_id: 'enrichment-blocked',
    utm_source: 'google',
  }, 'enrichment-first'));
  await assert.rejects(
    createWebsiteLeadSubmission(makeInput({
      ...common,
      external_lead_id: 'enrichment-blocked',
      attribution: {
        provider: 'google',
        source: 'google',
        click_ids: { gclid: 'new-gclid' },
      },
    }, 'enrichment-second')),
    (error) => error.code === 'EXTERNAL_ID_CONFLICT',
  );

  const [counts, persisted] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*)::int FROM website_lead_submissions WHERE tenant_id=$1) AS submissions,
      (SELECT count(*)::int FROM leads WHERE tenant_id=$1 AND source='WEBSITE_FORM' AND stage='NEW') AS leads,
      (SELECT count(*)::int FROM meta_conversion_events WHERE tenant_id=$1) AS meta_events,
      (SELECT count(*)::int FROM meta_jobs WHERE tenant_id=$1) AS meta_jobs,
      (SELECT count(*)::int FROM wa2_contact_links WHERE tenant_id=$1) AS wa2_links,
      (SELECT count(*)::int FROM lead_verified_whatsapp_identities WHERE tenant_id=$1) AS identities`, [tenant]),
    pool.query(`SELECT attribution_json
      FROM website_lead_submissions
      WHERE tenant_id=$1 AND external_lead_id='enrichment-blocked'`, [tenant]),
  ]);
  assert.deepEqual(counts.rows[0], {
    submissions: 4,
    leads: 4,
    meta_events: 0,
    meta_jobs: 0,
    wa2_links: 0,
    identities: 0,
  });
  assert.deepEqual(persisted.rows[0].attribution_json, { provider: 'google', source: 'google' });
});
