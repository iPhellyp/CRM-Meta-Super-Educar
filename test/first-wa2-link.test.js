import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isFirstWa2LinkTemporallyEligible } from '../src/historical-sync.js';

const db = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');

test('planilha armada aceita somente APPLY posterior ao armamento', () => {
  const lead = {
    source: 'META_INSTANT_FORM',
    awaiting_manual_reclassification: true,
    reclassification_armed_at: '2026-08-06T10:00:00.000Z',
  };
  assert.equal(isFirstWa2LinkTemporallyEligible({
    lead,
    eventObservedAt: '2026-08-06T10:00:01.000Z',
  }), true);
  assert.equal(isFirstWa2LinkTemporallyEligible({
    lead,
    eventObservedAt: '2026-08-06T09:59:59.000Z',
  }), false);
});

test('lead novo Meta sem armamento aceita APPLY posterior à chegada', () => {
  const lead = {
    source: 'META_INSTANT_FORM',
    awaiting_manual_reclassification: false,
    received_at: '2026-08-06T10:00:00.000Z',
    created_at: '2026-08-06T09:59:00.000Z',
  };
  assert.equal(isFirstWa2LinkTemporallyEligible({
    lead,
    eventObservedAt: '2026-08-06T10:00:01.000Z',
  }), true);
  assert.equal(isFirstWa2LinkTemporallyEligible({
    lead,
    eventObservedAt: '2026-08-06T09:59:59.000Z',
  }), false);
});

test('primeiro vínculo exige match determinístico e preserva proteções', () => {
  const resolver = db.slice(db.indexOf('async function resolveFirstWa2LinkLead'), db.indexOf('async function createFirstWa2Link'));
  assert.match(resolver, /source = 'META_INSTANT_FORM'/);
  assert.match(resolver, /stage = 'NEW'/);
  assert.match(resolver, /meta_lead_id IS NOT NULL/);
  assert.match(resolver, /isFirstWa2LinkTemporallyEligible/);
  assert.match(resolver, /MULTIPLE_LEAD_MATCHES/);
  assert.match(resolver, /PHONE_IDENTITY_UNRESOLVED/);
  assert.match(db, /pending\.spreadsheetArmed/);
  assert.match(db, /system:meta-lead-first-link/);
  assert.match(db, /ON CONFLICT \(event_id\) DO NOTHING/);
});

test('não exige awaiting_manual_reclassification no match de lead Meta novo', () => {
  const resolver = db.slice(db.indexOf('async function resolveFirstWa2LinkLead'), db.indexOf('async function createFirstWa2Link'));
  assert.match(resolver, /awaiting_manual_reclassification = true/);
  assert.match(resolver, /awaiting_manual_reclassification = false/);
  assert.match(resolver, /awaiting_manual_reclassification === true/);
});
