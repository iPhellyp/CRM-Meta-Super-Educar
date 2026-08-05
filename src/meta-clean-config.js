import fs from 'node:fs';

export const META_CLEAN_ENV_FILE = '/run/secrets/meta-clean.env';
export const META_CLEAN_DATASET_ID = '1059632093187676';
export const META_LEGACY_DATASET_ID = '775516968145969';

const KEYS = [
  'META_CLEAN_DATASET_ID',
  'META_CLEAN_ACCESS_TOKEN',
  'META_CLEAN_OUTBOUND_ENABLED',
  'META_CLEAN_TEST_MODE',
  'META_CLEAN_HISTORICAL_BACKFILL',
];

function parseEnvFile(content) {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || !KEYS.includes(match[1])) continue;
    values[match[1]] = match[2].trim();
  }
  return values;
}

export function readMetaCleanConfig({ env = process.env, filePath = env.META_CLEAN_ENV_FILE || META_CLEAN_ENV_FILE } = {}) {
  let fileValues = {};
  try {
    fileValues = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fileValues = {};
  }
  const value = (key) => key === 'META_CLEAN_ACCESS_TOKEN'
    ? fileValues[key] || ''
    : String(env[key] ?? fileValues[key] ?? '').trim();
  const datasetId = value('META_CLEAN_DATASET_ID');
  return {
    datasetId,
    accessToken: value('META_CLEAN_ACCESS_TOKEN'),
    outboundEnabled: value('META_CLEAN_OUTBOUND_ENABLED') === 'true',
    testMode: value('META_CLEAN_TEST_MODE') === 'true',
    historicalBackfill: value('META_CLEAN_HISTORICAL_BACKFILL') === 'true',
    datasetIsClean: datasetId === META_CLEAN_DATASET_ID && datasetId !== META_LEGACY_DATASET_ID,
  };
}

export function metaCleanConfigStatus(options = {}) {
  const config = readMetaCleanConfig(options);
  return {
    datasetId: config.datasetId || null,
    datasetIsClean: config.datasetIsClean,
    tokenPresent: Boolean(config.accessToken),
    outboundEnabled: config.outboundEnabled,
    testMode: config.testMode,
    historicalBackfill: config.historicalBackfill,
  };
}

export function assertMetaCleanConfig(config, { requireOutbound = false } = {}) {
  if (!config?.datasetIsClean) throw new Error('META_CLEAN_DATASET_INVALID');
  if (!config.accessToken) throw new Error('META_CLEAN_ACCESS_TOKEN_MISSING');
  if (requireOutbound && !config.outboundEnabled) throw new Error('META_CLEAN_OUTBOUND_DISABLED');
  if (config.historicalBackfill) throw new Error('META_CLEAN_HISTORICAL_BACKFILL_ENABLED');
  return config;
}
