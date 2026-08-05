import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertMetaCleanConfig,
  META_CLEAN_DATASET_ID,
  META_LEGACY_DATASET_ID,
  metaCleanConfigStatus,
  readMetaCleanConfig,
} from '../src/meta-clean-config.js';

test('loader do dataset limpo lê somente o segredo montado e nunca o expõe no status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-meta-clean-'));
  const filePath = path.join(directory, 'meta-clean.env');
  const token = 'token-test-only-not-for-output';
  fs.writeFileSync(filePath, [
    `META_CLEAN_DATASET_ID=${META_CLEAN_DATASET_ID}`,
    `META_CLEAN_ACCESS_TOKEN=${token}`,
    'META_CLEAN_OUTBOUND_ENABLED=false',
    'META_CLEAN_TEST_MODE=true',
    'META_CLEAN_HISTORICAL_BACKFILL=false',
  ].join('\n'));
  const config = readMetaCleanConfig({
    env: { META_CLEAN_ENV_FILE: filePath },
    filePath,
  });
  const status = metaCleanConfigStatus({
    env: { META_CLEAN_ENV_FILE: filePath },
    filePath,
  });
  assert.equal(config.datasetIsClean, true);
  assert.equal(config.accessToken, token);
  assert.equal(status.tokenPresent, true);
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal(assertMetaCleanConfig(config).datasetId, META_CLEAN_DATASET_ID);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('loader rejeita dataset legado e backfill histórico', () => {
  assert.throws(() => assertMetaCleanConfig({
    datasetId: META_LEGACY_DATASET_ID,
    accessToken: 'present',
    historicalBackfill: false,
    datasetIsClean: false,
  }), { message: 'META_CLEAN_DATASET_INVALID' });
  assert.throws(() => assertMetaCleanConfig({
    datasetId: META_CLEAN_DATASET_ID,
    accessToken: 'present',
    historicalBackfill: true,
    datasetIsClean: true,
  }), { message: 'META_CLEAN_HISTORICAL_BACKFILL_ENABLED' });
});
