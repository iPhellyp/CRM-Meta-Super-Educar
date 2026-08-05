import { closePool, createMetaCleanHistoricalBatch, listMetaCleanHistoricalCandidates } from '../src/db.js';
import { META_CLEAN_DATASET_ID, readMetaCleanConfig } from '../src/meta-clean-config.js';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const dryRun = args.has('--dry-run') || !execute;
const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

function mask(value) {
  const text = String(value || '');
  return text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : '[masked]';
}

try {
  if (execute && dryRun) throw new Error('ESCOLHA_DRY_RUN_OU_EXECUTE');
  const config = readMetaCleanConfig();
  if (!config.datasetIsClean || config.datasetId !== META_CLEAN_DATASET_ID) {
    throw new Error('META_CLEAN_DATASET_INVALID');
  }
  if (!config.accessToken) throw new Error('META_CLEAN_ACCESS_TOKEN_MISSING');
  if (config.historicalBackfill) throw new Error('META_CLEAN_HISTORICAL_FLAG_INVALID');
  if (execute && !config.outboundEnabled) throw new Error('META_CLEAN_OUTBOUND_DISABLED');

  const candidates = await listMetaCleanHistoricalCandidates({
    datasetId: META_CLEAN_DATASET_ID,
    cutoff,
    limit: 25,
  });
  if (candidates.length > 25) throw new Error('META_CLEAN_HISTORICAL_BATCH_TOO_LARGE');
  if (candidates.length === 0) {
    console.log(JSON.stringify({
      mode: dryRun ? 'DRY_RUN' : 'EXECUTE',
      datasetId: META_CLEAN_DATASET_ID,
      cutoff: cutoff.toISOString(),
      candidates: 0,
      writes: 0,
      jobsCreated: 0,
      graphPost: 0,
      retry: false,
    }));
    process.exitCode = 0;
  } else {
    const result = await createMetaCleanHistoricalBatch({
      candidates,
      datasetId: META_CLEAN_DATASET_ID,
      cutoff,
      dryRun,
    });
    const stages = candidates.reduce((counts, candidate) => {
      counts[candidate.stage] = (counts[candidate.stage] || 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      mode: dryRun ? 'DRY_RUN' : 'EXECUTE',
      datasetId: META_CLEAN_DATASET_ID,
      cutoff: cutoff.toISOString(),
      candidates: candidates.length,
      stages,
      firstEventTime: candidates[0]?.event_time || null,
      lastEventTime: candidates.at(-1)?.event_time || null,
      sampleLead: mask(candidates[0]?.lead_id),
      writes: result.writes,
      eventsInserted: result.dryRun ? 0 : result.events,
      jobsCreated: result.dryRun ? 0 : result.jobs,
      graphPost: 0,
      retry: false,
    }));
  }
} catch (error) {
  const code = /^[A-Z0-9_.:-]{1,100}$/.test(String(error?.message || ''))
    ? error.message
    : 'META_CLEAN_HISTORICAL_FAILED';
  console.log(JSON.stringify({ mode: 'ERROR', code, graphPost: 0, retry: false }));
  process.exitCode = 1;
} finally {
  await closePool();
}
