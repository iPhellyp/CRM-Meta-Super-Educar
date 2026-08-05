import 'dotenv/config';
import fs from 'node:fs/promises';
import {
  closePool,
  importSpreadsheetLeads,
  validateDatabaseConfig,
} from '../src/db.js';
import { parseUnivcSpreadsheet } from '../src/lead-file-import.js';

const BUSINESS_ID = '4589264227835647';
const DATASET_ID = '1059632093187676';
const CONNECTION_NAME = 'Super Educar Brasil - CAPI Produção';
const SOURCE = 'OWNER_CONFIRMED_FORM_MAPPING';
const DEFAULT_FILE = '/tmp/LEADS-GERAL-FORMULARIOS-UNIVC-2026.xlsx';
const ALLOWLIST = Object.freeze({
  '1760211795329890': { pageId: '1119504964569694', routingSource: SOURCE },
  '1302569368461458': { pageId: null, routingSource: SOURCE },
  '2218606335646994': { pageId: null, routingSource: SOURCE },
  '938080202533544': { pageId: null, routingSource: SOURCE },
  '1529922911562967': { pageId: null, routingSource: SOURCE },
});

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const filePath = argValue('--file', DEFAULT_FILE);
const execute = process.argv.includes('--execute');
const actor = argValue('--actor', 'admin:spreadsheet-import-2026');

try {
  const buffer = await fs.readFile(filePath);
  const parsed = parseUnivcSpreadsheet(buffer, filePath.split(/[\\/]/u).at(-1));
  const phoneCounts = new Map();
  for (const row of parsed.rows) {
    if (row.phoneNormalized) phoneCounts.set(row.phoneNormalized, (phoneCounts.get(row.phoneNormalized) || 0) + 1);
  }
  const summary = {
    rows: parsed.rows.length,
    uniqueMetaLeadIds: new Set(parsed.rows.map((row) => row.metaLeadId).filter(Boolean)).size,
    validPhones: parsed.rows.filter((row) => row.phoneNormalized).length,
    invalidOrMissingPhones: parsed.rows.filter((row) => !row.phoneNormalized).length,
    possibleDuplicateRows: parsed.rows.filter((row) => row.phoneNormalized && phoneCounts.get(row.phoneNormalized) > 1).length,
    forms: Object.fromEntries(Object.keys(ALLOWLIST).map((formId) => [
      formId,
      parsed.rows.filter((row) => row.metaFormId === formId).length,
    ])),
    sha256: parsed.sha256,
  };
  if (!execute) {
    console.log(JSON.stringify({ dryRun: true, ...summary, writes: 0, graphPosts: 0 }));
    process.exitCode = 0;
  } else {
    validateDatabaseConfig();
    const result = await importSpreadsheetLeads({
      parsedFile: parsed,
      actor,
      businessId: BUSINESS_ID,
      datasetId: DATASET_ID,
      connectionName: CONNECTION_NAME,
      allowlist: ALLOWLIST,
    });
    console.log(JSON.stringify({
      executed: true,
      idempotent: result.idempotent === true,
      ...summary,
      counts: result.counts,
      graphPosts: 0,
      metaEvents: 0,
      metaJobs: 0,
    }));
  }
} finally {
  await closePool();
}
