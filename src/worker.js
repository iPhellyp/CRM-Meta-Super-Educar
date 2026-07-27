import 'dotenv/config';
import {
  claimNextWa2LabelJob,
  claimNextJob,
  closePool,
  completeWa2LabelJob,
  completeJob,
  failWa2LabelJob,
  failJob,
  getMetaEventContext,
  getWa2LabelJobContext,
  markMetaEventFailed,
  markMetaEventProcessing,
  markMetaEventSent,
  migrate,
  recordWorkerHeartbeat,
  requeueWa2LabelJobForRemoteConfirmation,
  validateDatabaseConfig,
} from './db.js';
import {
  importLeadgenId,
  isTemporaryMetaError,
  sendMetaConversion,
  validateMetaConfig,
} from './meta.js';
import {
  applyWa2ChatLabel,
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

async function heartbeatIfNeeded() {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  await recordWorkerHeartbeat();
  lastHeartbeatAt = Date.now();
}

async function run() {
  validateDatabaseConfig();
  validateMetaConfig();
  validateWa2Config();
  await migrate();
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
    if (!wa2Job) {
      if (!metaJob) await delay(IDLE_DELAY_MS);
      continue;
    }

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
