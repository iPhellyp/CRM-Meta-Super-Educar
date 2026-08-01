import process from 'node:process';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const dryRun = args.has('--dry-run') || !execute;
const batchFlag = process.argv.find((value) => value.startsWith('--batch-size='));
const batchSize = batchFlag ? Number(batchFlag.split('=')[1]) : 50;
const tenantFlag = process.argv.find((value) => value.startsWith('--tenant='));
if (tenantFlag) process.env.DEFAULT_TENANT_ID = tenantFlag.split('=')[1];

if (execute && dryRun) throw new Error('Escolha --dry-run ou --execute');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
  throw new Error('--batch-size deve ser um inteiro entre 1 e 500');
}

const { backfillMetaQualifiedEvents, pool } = await import('../src/db.js');
try {
  const result = await backfillMetaQualifiedEvents({ batchSize, execute });
  console.log(JSON.stringify({
    mode: dryRun ? 'DRY_RUN' : 'EXECUTE',
    tenant: process.env.DEFAULT_TENANT_ID || 'super-educar',
    selected: result.selected,
    created: result.created,
    queued: result.queued,
  }));
} finally {
  await pool.end();
}
