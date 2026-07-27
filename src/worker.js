import 'dotenv/config';
import {
  claimMetaHistoricalImport,
  claimWa2LabelEventCursor,
  claimWa2ReconciliationItem,
  claimNextWa2LabelJob,
  claimNextJob,
  closePool,
  completeWa2LabelJob,
  completeMetaHistoricalPage,
  completeWa2LabelEventPage,
  completeWa2ReconciliationItem,
  completeJob,
  failWa2LabelJob,
  failWa2LabelEventCursor,
  failWa2ReconciliationItem,
  failJob,
  getMetaEventContext,
  getWa2LabelJobContext,
  markMetaEventFailed,
  markMetaEventProcessing,
  markMetaEventSent,
  metaHistoricalImportIsActive,
  pauseMetaHistoricalImport,
  processWa2LabelEvent,
  recordMetaHistoricalInvalid,
  recordMetaHistoricalLead,
  recordWorkerHeartbeat,
  requeueWa2LabelJobForRemoteConfirmation,
  validateDatabaseConfig,
} from './db.js';
import { runStartupMigrations } from './startup-migrations.js';
import {
  importLeadPayload,
  importLeadgenId,
  isTemporaryMetaError,
  listMetaFormLeadsPage,
  sendMetaConversion,
  validateMetaConfig,
} from './meta.js';
import {
  applyWa2ChatLabel,
  getWa2ContactByPhone,
  listWa2LabelEvents,
  listWa2ChatLabels,
  removeWa2ChatLabel,
  validateWa2Config,
} from './wa2.js';
import {
  isTemporaryWa2LabelError,
  sanitizeWa2LabelJobError,
  synchronizeWa2LabelJob,
  wa2LabelJobCompletionDecision,
  wa2LabelRetryDelayMs,
} from './wa2-label-sync.js';
import {
  historicalRetryDelayMs,
  reconciliationFailureResult,
  sanitizeHistoricalError,
} from './historical-sync.js';

const MAX_ATTEMPTS = 6;
const IDLE_DELAY_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
let stopping = false;
let lastHeartbeatAt = 0;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAt(attempts) {
  const seconds = Math.min(30 * (2 ** Math.max(attempts - 1, 0)), 30 * 60);
  return new Date(Date.now() + seconds * 1000);
}

async function processJob(job) {
  if (job.job_type === 'LEAD_IMPORT') {
    await importLeadgenId(
      job.payload.metaLeadId,
      job.payload.webhookValue,
      job.payload.receivedAt,
      job.tenant_id,
    );
    await completeJob(job.id);
    return;
  }

  if (job.job_type === 'CONVERSION') {
    const event = await getMetaEventContext(job.payload.eventId);
    if (!event) throw new Error('Evento de conversão não encontrado');
    if (event.status === 'SENT') {
      await completeJob(job.id);
      return;
    }
    await markMetaEventProcessing(event.id, job.attempts);
    const response = await sendMetaConversion(event);
    await markMetaEventSent(event.id, response, job.attempts);
    await completeJob(job.id);
    return;
  }

  throw new Error(`Tipo de job não suportado: ${job.job_type}`);
}

async function handleFailure(job, error) {
  const willRetry = isTemporaryMetaError(error) && job.attempts < MAX_ATTEMPTS;
  const nextAttemptAt = willRetry ? retryAt(job.attempts) : null;
  await failJob(job.id, error, { retryAt: nextAttemptAt });
  if (job.job_type === 'CONVERSION' && job.payload?.eventId) {
    await markMetaEventFailed(job.payload.eventId, error, job.attempts, willRetry);
  }
  console.error(JSON.stringify({
    level: 'error',
    msg: willRetry ? 'Job reagendado' : 'Job marcado como FAILED',
    jobId: job.id,
    jobType: job.job_type,
    attempts: job.attempts,
    nextAttemptAt,
    error: String(error),
  }));
}

async function processWa2LabelJob(job) {
  const context = await getWa2LabelJobContext(job.id);
  if (!context) {
    const error = new Error('Configuração, vínculo ou instância do job não está mais ativa');
    error.code = 'WA2_LABEL_JOB_CONTEXT_INVALID';
    throw error;
  }
  const syncResult = await synchronizeWa2LabelJob(context, {
    listWa2ChatLabels,
    applyWa2ChatLabel,
    removeWa2ChatLabel,
  });
  const decision = wa2LabelJobCompletionDecision(syncResult, job);
  if (decision.status === 'DONE') {
    await completeWa2LabelJob(job.id);
  } else if (decision.status === 'PENDING') {
    await requeueWa2LabelJobForRemoteConfirmation(job.id, decision);
  } else {
    await failWa2LabelJob(job.id, decision.error);
  }
  return decision;
}

async function handleWa2LabelFailure(job, error) {
  const willRetry =
    isTemporaryWa2LabelError(error) &&
    job.attempts < job.max_attempts;
  const retryAt = willRetry
    ? new Date(Date.now() + wa2LabelRetryDelayMs(job.attempts))
    : null;
  const safeError = sanitizeWa2LabelJobError(error);
  await failWa2LabelJob(job.id, safeError, { retryAt });
  console.error(JSON.stringify({
    level: 'error',
    msg: willRetry ? 'Job WA2 reagendado' : 'Job WA2 marcado como FAILED',
    jobId: job.id,
    jobType: 'WA2_LABEL_SYNC',
    attempts: job.attempts,
    nextAttemptAt: retryAt,
    errorCode: safeError.code,
  }));
}

async function processWa2LabelFeed() {
  const cursor = await claimWa2LabelEventCursor();
  if (!cursor) return false;
  try {
    const page = await listWa2LabelEvents({
      after: cursor.cursor_value,
      limit: 100,
    });
    const results = [];
    for (const event of page.events) {
      let currentLabelIds = [];
      if (
        event.source === 'WHATSAPP' &&
        event.operation === 'APPLY' &&
        event.eligibleForCrm
      ) {
        const labels = await listWa2ChatLabels(event.instanceId, event.chatId);
        currentLabelIds = labels.map((label) => label.id);
      }
      results.push(await processWa2LabelEvent(event, currentLabelIds));
    }
    await completeWa2LabelEventPage(page.nextCursor, results);
    return page.events.length > 0 || page.hasMore;
  } catch (error) {
    const safe = sanitizeHistoricalError(error, 'WA2_LABEL_FEED_FAILED');
    await failWa2LabelEventCursor(
      safe,
      new Date(Date.now() + historicalRetryDelayMs(1)),
    );
    return false;
  }
}

async function processMetaHistoricalImport() {
  const run = await claimMetaHistoricalImport();
  if (!run) return false;
  try {
    const page = await listMetaFormLeadsPage(run.form_id, {
      after: run.cursor_value,
      limit: 100,
    });
    for (const [index, payload] of page.leads.entries()) {
      if (!await metaHistoricalImportIsActive(run.id)) return false;
      const metaLeadId = String(
        payload?.id || `invalid:${run.cursor_value || 'start'}:${index}`,
      ).slice(0, 100);
      try {
        await importLeadPayload(
          payload,
          { page_id: run.page_id, form_id: run.form_id },
          null,
          run.tenant_id,
          {
            upsert: (leadInput) => recordMetaHistoricalLead(run.id, leadInput),
          },
        );
      } catch (error) {
        if (isTemporaryMetaError(error)) throw error;
        const safe = sanitizeHistoricalError(error, 'META_LEAD_INVALID');
        await recordMetaHistoricalInvalid(run.id, metaLeadId, safe.code);
      }
    }
    await completeMetaHistoricalPage(run.id, page);
    return true;
  } catch (error) {
    await pauseMetaHistoricalImport(
      run.id,
      sanitizeHistoricalError(error, 'META_HISTORICAL_IMPORT_FAILED'),
    );
    return false;
  }
}

async function processWa2Reconciliation() {
  const item = await claimWa2ReconciliationItem();
  if (!item) return false;
  if (!item.phone_normalized) {
    await failWa2ReconciliationItem(
      item,
      'PHONE_INVALID',
      'WA2_PHONE_INVALID',
      false,
    );
    return true;
  }
  try {
    const resolved = await getWa2ContactByPhone(
      item.remote_instance_id,
      item.phone_normalized,
    );
    if (!resolved.chat) {
      await failWa2ReconciliationItem(
        item,
        'CONTACT_WITHOUT_CHAT',
        'WA2_CONTACT_WITHOUT_CHAT',
        false,
      );
      return true;
    }
    const labels = await listWa2ChatLabels(
      item.remote_instance_id,
      resolved.chat.id,
    );
    await completeWa2ReconciliationItem(item, {
      ...resolved,
      remoteLabelIds: labels.map((label) => label.id),
    });
    return true;
  } catch (error) {
    const temporary = isTemporaryWa2LabelError(error) && item.attempts < 5;
    const safe = sanitizeHistoricalError(error, 'WA2_RECONCILIATION_FAILED');
    await failWa2ReconciliationItem(
      item,
      reconciliationFailureResult(error),
      safe.code,
      temporary,
    );
    return true;
  }
}

async function heartbeatIfNeeded() {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  await recordWorkerHeartbeat();
  lastHeartbeatAt = Date.now();
}

async function run() {
  validateDatabaseConfig();
  validateMetaConfig();
  validateWa2Config();
  await runStartupMigrations();
  await recordWorkerHeartbeat({ started: true });
  lastHeartbeatAt = Date.now();
  console.log(JSON.stringify({ level: 'info', msg: 'Worker Meta iniciado' }));

  while (!stopping) {
    await heartbeatIfNeeded();
    if (stopping) break;
    const metaJob = await claimNextJob();
    if (metaJob) {
      try {
        if (metaJob.attempts > MAX_ATTEMPTS) {
          throw new Error('Limite de tentativas excedido');
        }
        await processJob(metaJob);
        console.log(JSON.stringify({
          level: 'info',
          msg: 'Job concluído',
          jobId: metaJob.id,
          jobType: metaJob.job_type,
          attempts: metaJob.attempts,
        }));
      } catch (error) {
        await handleFailure(metaJob, error);
      }
    }

    const wa2Job = await claimNextWa2LabelJob();
    if (wa2Job) {
      try {
        const decision = await processWa2LabelJob(wa2Job);
        console.log(JSON.stringify({
          level: 'info',
          msg: decision.status === 'DONE'
            ? 'Job WA2 concluído'
            : decision.status === 'PENDING'
              ? 'Job WA2 aguardando confirmação remota'
              : 'Job WA2 sem convergência marcado como FAILED',
          jobId: wa2Job.id,
          jobType: 'WA2_LABEL_SYNC',
          attempts: wa2Job.attempts,
          status: decision.status,
        }));
      } catch (error) {
        await handleWa2LabelFailure(wa2Job, error);
      }
    }

    const feedWorked = await processWa2LabelFeed();
    const importWorked = await processMetaHistoricalImport();
    const reconciliationWorked = await processWa2Reconciliation();
    if (!metaJob && !wa2Job && !feedWorked && !importWorked && !reconciliationWorked) {
      await delay(IDLE_DELAY_MS);
    }
  }
}

function stop(signal) {
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'Worker encerrando', signal }));
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

try {
  await run();
} catch (error) {
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Worker interrompido por erro fatal',
    error: String(error),
  }));
  process.exitCode = 1;
} finally {
  await closePool();
}
