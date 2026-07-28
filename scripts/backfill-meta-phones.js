import { pathToFileURL } from 'node:url';
import { decryptSecret } from '../src/secret-crypto.js';
import { normalizeBrazilianPhone } from '../src/phone.js';

const MAX_INITIAL_LIMIT = 10;

function backfillError(code, message) {
  const error = new Error(message);
  error.backfillCode = code;
  return error;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function parseOptions() {
  const rawLimit = argumentValue('--limit');
  const limit = Number(rawLimit);
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  const tenant = String(argumentValue('--tenant') || '').trim();

  if (!rawLimit || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INITIAL_LIMIT) {
    throw backfillError(
      'INVALID_LIMIT',
      'Informe --limit com um inteiro entre 1 e 10.',
    );
  }
  if (dryRun === apply) {
    throw backfillError(
      'INVALID_MODE',
      'Informe exatamente um modo: --dry-run ou --apply.',
    );
  }
  if (!tenant) {
    throw backfillError(
      'TENANT_REQUIRED',
      'Informe explicitamente o tenant com --tenant.',
    );
  }
  if (tenant !== String(process.env.DEFAULT_TENANT_ID || '').trim()) {
    throw backfillError(
      'TENANT_MISMATCH',
      '--tenant deve corresponder exatamente a DEFAULT_TENANT_ID.',
    );
  }
  return { limit, dryRun, tenant };
}

function accessTokenFor(candidate) {
  if (candidate.meta_connection_id) {
    if (
      candidate.connection_active !== true ||
      candidate.connection_status !== 'VALID' ||
      !candidate.encrypted_access_token
    ) {
      throw backfillError(
        'TOKEN_UNAVAILABLE',
        `Lead Meta ${candidate.meta_lead_id}: conexão de origem sem token válido.`,
      );
    }
    try {
      const token = String(decryptSecret(candidate.encrypted_access_token) || '').trim();
      if (!token) throw new Error('empty');
      return token;
    } catch {
      throw backfillError(
        'TOKEN_UNAVAILABLE',
        `Lead Meta ${candidate.meta_lead_id}: não foi possível obter o token da conexão.`,
      );
    }
  }
  const legacyToken = String(process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  if (!legacyToken) {
    throw backfillError(
      'TOKEN_UNAVAILABLE',
      `Lead Meta ${candidate.meta_lead_id}: token da conexão e fallback legado indisponíveis.`,
    );
  }
  return legacyToken;
}

function sourceContextFor(candidate) {
  if (!candidate.meta_connection_id) return null;
  return {
    id: candidate.meta_connection_id,
    business_id: candidate.business_id,
    ad_account_id: candidate.ad_account_id,
    dataset_id: candidate.dataset_id,
  };
}

export async function processMetaPhoneCandidates(
  candidates,
  {
    dryRun,
    tenant,
    limit,
    importLeadgenId,
  },
) {
  const summary = {
    mode: dryRun ? 'dry-run' : 'apply',
    tenantId: tenant,
    limit,
    selectedCount: candidates.length,
    phoneFoundCount: 0,
    updatedCount: 0,
    missingPhoneCount: 0,
    failedCount: 0,
    selectedMetaLeadIds: candidates.map((lead) => lead.meta_lead_id),
    phoneFoundMetaLeadIds: [],
    updatedMetaLeadIds: [],
    missingPhoneMetaLeadIds: [],
    failedMetaLeadIds: [],
  };

  for (const candidate of candidates) {
    try {
      const accessToken = accessTokenFor(candidate);
      const sourceContext = sourceContextFor(candidate);
      const imported = await importLeadgenId(
        candidate.meta_lead_id,
        {
          page_id: candidate.meta_page_id,
          form_id: candidate.meta_form_id,
        },
        null,
        tenant,
        {
          accessToken,
          sourceContext,
          logOptionalErrors: false,
          ...(dryRun
            ? { upsert: async (input) => input }
            : {}),
        },
      );
      const normalized = normalizeBrazilianPhone(
        imported.phone_normalized || imported.phone,
      );
      if (!normalized) {
        summary.missingPhoneCount += 1;
        summary.missingPhoneMetaLeadIds.push(candidate.meta_lead_id);
        continue;
      }
      summary.phoneFoundCount += 1;
      summary.phoneFoundMetaLeadIds.push(candidate.meta_lead_id);
      if (!dryRun) {
        summary.updatedCount += 1;
        summary.updatedMetaLeadIds.push(candidate.meta_lead_id);
      }
    } catch {
      summary.failedCount += 1;
      summary.failedMetaLeadIds.push(candidate.meta_lead_id);
    }
  }

  return summary;
}

async function run() {
  await import('dotenv/config');
  const options = parseOptions();
  const [{ pool, closePool }, { importLeadgenId }] = await Promise.all([
    import('../src/db.js'),
    import('../src/meta.js'),
  ]);

  try {
    const candidates = await pool.query(
      `SELECT lead.id, lead.meta_lead_id, lead.meta_page_id, lead.meta_form_id,
              lead.meta_connection_id, lead.business_id, lead.ad_account_id,
              lead.dataset_id, connection.encrypted_access_token,
              connection.active AS connection_active,
              connection.status AS connection_status
       FROM leads lead
       LEFT JOIN meta_connections connection
         ON connection.tenant_id = lead.tenant_id
        AND connection.id = lead.meta_connection_id
       WHERE lead.tenant_id = $1
         AND lead.source = 'META_INSTANT_FORM'
         AND lead.meta_lead_id IS NOT NULL
         AND lead.phone_normalized IS NULL
       ORDER BY lead.received_at, lead.id
       LIMIT $2`,
      [options.tenant, options.limit],
    );

    const summary = await processMetaPhoneCandidates(candidates.rows, {
      dryRun: options.dryRun,
      tenant: options.tenant,
      limit: options.limit,
      importLeadgenId,
    });

    console.log(JSON.stringify(summary));
    if (summary.failedCount > 0) process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const controlled = typeof error?.backfillCode === 'string';
    console.error(JSON.stringify({
      errorCode: controlled ? error.backfillCode : 'BACKFILL_FAILED',
      message: controlled
        ? error.message
        : 'Backfill Meta interrompido sem expor detalhes sensíveis.',
    }));
    process.exitCode = 1;
  });
}
