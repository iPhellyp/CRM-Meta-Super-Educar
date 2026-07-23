import 'dotenv/config';
import {
  claimNextJob,
  closePool,
  completeJob,
  failJob,
  getMetaEventContext,
  markMetaEventFailed,
  markMetaEventProcessing,
  markMetaEventSent,
  migrate,
  recordWorkerHeartbeat,
} from './db.js';
import { importLeadgenId, isTemporaryMetaError, sendMetaConversion } from './meta.js';

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
    await importLeadgenId(job.payload.metaLeadId, job.payload.webhookValue);
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

async function heartbeatIfNeeded() {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  await recordWorkerHeartbeat();
  lastHeartbeatAt = Date.now();
}

async function run() {
  await migrate();
  await recordWorkerHeartbeat({ started: true });
  lastHeartbeatAt = Date.now();
  console.log(JSON.stringify({ level: 'info', msg: 'Worker Meta iniciado' }));

  while (!stopping) {
    await heartbeatIfNeeded();
    const job = await claimNextJob();
    if (!job) {
      await delay(IDLE_DELAY_MS);
      continue;
    }

    try {
      await processJob(job);
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Job concluído',
        jobId: job.id,
        jobType: job.job_type,
        attempts: job.attempts,
      }));
    } catch (error) {
      await handleFailure(job, error);
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
    stack: error?.stack,
  }));
  process.exitCode = 1;
} finally {
  await closePool();
}
