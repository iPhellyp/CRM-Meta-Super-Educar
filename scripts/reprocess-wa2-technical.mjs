import 'dotenv/config';
import {
  claimWa2LabelEventCursor,
  closePool,
  completeWa2LabelEventPage,
  failWa2LabelEventCursor,
  getWa2LabelEventCursor,
  processWa2LabelEvent,
} from '../src/db.js';
import { listWa2LabelEvents } from '../src/wa2.js';

const dryRun = process.argv.includes('--dry-run');
const execute = process.argv.includes('--execute');

if (dryRun === execute) {
  throw new Error('USE_EXACTLY_ONE_MODE');
}

function countTechnicalEvent(event, counts) {
  if (event.technicalOnly) {
    counts.MALFORMED_HISTORICAL_RECORD = (counts.MALFORMED_HISTORICAL_RECORD || 0) + 1;
  } else if (event.eligibleForCrm) {
    counts.IGNORED_TECHNICAL_EVENT = (counts.IGNORED_TECHNICAL_EVENT || 0) + 1;
  } else {
    const reason = event.ineligibleReason || 'IGNORED_TECHNICAL_EVENT';
    counts[reason] = (counts[reason] || 0) + 1;
  }
}

async function runDryRun() {
  const cursor = await getWa2LabelEventCursor();
  if (!cursor) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', cursor: null, events: 0, classifications: {} }));
    return;
  }
  const page = await listWa2LabelEvents({ after: cursor.cursor_value, limit: 100 });
  const classifications = {};
  for (const event of page.events) countTechnicalEvent(event, classifications);
  console.log(JSON.stringify({
    mode: 'DRY_RUN',
    cursorStatus: cursor.status,
    events: page.events.length,
    hasMore: page.hasMore,
    classifications,
  }));
}

async function runExecute() {
  const totals = {
    pages: 0,
    events: 0,
    processed: 0,
    ignored: 0,
    conflicts: 0,
    pending: 0,
    technical: {},
  };
  while (true) {
    const cursor = await claimWa2LabelEventCursor();
    if (!cursor) break;
    try {
      const page = await listWa2LabelEvents({ after: cursor.cursor_value, limit: 100 });
      const results = [];
      for (const event of page.events) {
        countTechnicalEvent(event, totals.technical);
        if (event.technicalOnly || event.eligibleForCrm) {
          results.push({ action: 'IGNORED', code: event.technicalReason || 'IGNORED_TECHNICAL_EVENT' });
          continue;
        }
        results.push(await processWa2LabelEvent(event, []));
      }
      await completeWa2LabelEventPage(page.nextCursor, results);
      totals.pages += 1;
      totals.events += page.events.length;
      for (const result of results) {
        if (result.action === 'CONFLICT') totals.conflicts += 1;
        else if (result.action === 'PENDING_CONFIRMATION') totals.pending += 1;
        else if (result.action === 'IGNORED') totals.ignored += 1;
        else totals.processed += 1;
      }
      if (!page.hasMore) break;
    } catch (error) {
      const safe = {
        code: /^[A-Za-z0-9_.:-]{1,80}$/.test(String(error?.code || '')) ? error.code : 'WA2_TECHNICAL_REPROCESS_FAILED',
        message: String(error?.message || 'Falha de processamento').replace(/[\r\n\t]+/g, ' ').slice(0, 300),
      };
      // The cursor schema requires a timestamp. Keep this one-shot tool
      // blocked after an external failure; the operator may resume it
      // explicitly after the cause is understood.
      await failWa2LabelEventCursor(safe, new Date(Date.now() + 60_000));
      throw new Error(safe.code);
    }
  }
  console.log(JSON.stringify({ mode: 'EXECUTE', ...totals }));
}

try {
  if (dryRun) await runDryRun();
  else await runExecute();
} finally {
  await closePool();
}
