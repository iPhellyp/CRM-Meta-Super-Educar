import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [db, meta, server, worker, migration] = await Promise.all([
  readFile(new URL('../src/db.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/meta.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/worker.js', import.meta.url), 'utf8'),
  readFile(new URL('../sql/020_meta_lead_retrieval_token.sql', import.meta.url), 'utf8'),
]);

test('separa token de Lead Retrieval do token CAPI por conexão', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS encrypted_lead_retrieval_access_token/);
  assert.match(db, /encrypted_access_token, encrypted_lead_retrieval_access_token/);
  assert.match(db, /replaceMetaConnectionLeadRetrievalToken/);
  assert.match(worker, /sourceContext\.encrypted_lead_retrieval_access_token/);
  assert.doesNotMatch(worker, /decryptSecret\(sourceContext\.encrypted_access_token\)/);
  assert.doesNotMatch(worker, /META_PAGE_ACCESS_TOKEN/);
});

test('importação de lead exige token explícito e não usa fallback CAPI', () => {
  assert.match(meta, /META_LEAD_RETRIEVAL_TOKEN_NOT_CONFIGURED/);
  assert.match(meta, /token: options\.accessToken,/);
  assert.doesNotMatch(meta, /options\.accessToken \|\| process\.env\.META_PAGE_ACCESS_TOKEN/);
  assert.match(server, /leadRetrievalAccessToken/);
  assert.match(server, /lead-retrieval-token/);
});

test('retry oficial só reabre job FAILED dentro do tenant', () => {
  assert.match(db, /if \(!job \|\| job\.status !== 'FAILED'\)/);
  assert.match(db, /SET status = 'RETRY', attempts = 0/);
  assert.match(server, /app\.post\('\/jobs\/:id\/retry'/);
});
