import 'dotenv/config';
import {
  closePool,
  completeJob,
  createMetaCleanCanaryEvent,
  failJob,
  getMetaCleanCanarySnapshot,
  getMetaConnectionById,
  listMetaConnections,
  markMetaEventFailed,
  markMetaEventSent,
  setMetaDatasetActive,
  upsertMetaDataset,
} from '../src/db.js';
import { sendMetaCleanCanary } from '../src/meta.js';
import {
  META_CLEAN_DATASET_ID,
  META_LEGACY_DATASET_ID,
  metaCleanConfigStatus,
} from '../src/meta-clean-config.js';

const LEAD_ID = 'a1d7206f-4de2-4205-95d5-de3184904940';
const DATASET_ID = META_CLEAN_DATASET_ID;
const DATASET_NAME = 'CRM Super Educar - Qualificados Limpos - 2026-08-03';
const CRM02_REMOTE_LABEL_ID = '36';

function mask(value, visibleStart = 6, visibleEnd = 4) {
  const text = String(value || '');
  if (text.length <= visibleStart + visibleEnd) return '[masked]';
  return `${text.slice(0, visibleStart)}…${text.slice(-visibleEnd)}`;
}

function safeError(error) {
  const code = /^[A-Z0-9_.:-]{1,100}$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'META_CLEAN_CANARY_FAILED';
  let graph = null;
  try {
    const parsed = JSON.parse(String(error?.message || ''));
    graph = {
      status: Number.isInteger(parsed.status) ? parsed.status : null,
      code: Number.isInteger(parsed.code) ? parsed.code : null,
      subcode: Number.isInteger(parsed.subcode) ? parsed.subcode : null,
      fbtrace_id: typeof parsed.traceId === 'string' ? parsed.traceId : null,
    };
  } catch {
    // Keep administrative errors code-only and never echo raw messages.
  }
  return { code, graph };
}

function snapshotChecks(snapshot, configStatus) {
  const lead = snapshot.lead;
  const dataset = snapshot.dataset;
  const validMql = snapshot.events.filter((event) => event.validity_status === 'VALID');
  const historicalMql = snapshot.events.filter((event) => event.validity_status === 'INVALIDATED');
  const legacyBlocked = snapshot.legacyDatasets.length === 0 || snapshot.legacyDatasets.every(
    (item) => item.active !== true,
  );
  const checks = {
    leadExists: Boolean(lead),
    notInternalTest: lead?.is_internal_test === false,
    metaLeadPresent: Boolean(lead?.meta_lead_id),
    outboundEligible: lead?.meta_outbound_eligible === true,
    oneActiveLink: snapshot.activeLinks.length === 1,
    oneVerifiedIdentity: snapshot.verifiedIdentities.length === 1,
    crm02Active: snapshot.currentConfirmation?.remote_label_id === CRM02_REMOTE_LABEL_ID,
    qualified: lead?.stage === 'QUALIFIED',
    stageSourceWhatsApp: lead?.stage_source === 'WHATSAPP_LABEL',
    stageVerified: lead?.stage_verification_status === 'VERIFIED',
    currentConfirmation: Boolean(snapshot.currentConfirmation),
    noValidMql: validMql.length === 0,
    historicalMqlOnlyInvalidated: snapshot.events.length === historicalMql.length,
    cleanDatasetRegistered: Boolean(dataset),
    cleanDatasetActive: dataset?.active === true,
    cleanConnectionActive: dataset?.connection_active === true,
    cleanConnectionValid: dataset?.connection_status === 'VALID',
    leadUsesCleanConnection: Boolean(
      lead?.meta_connection_id && dataset?.meta_connection_id
        && lead.meta_connection_id === dataset.meta_connection_id,
    ),
    legacyBlocked,
    cleanConfig: configStatus.datasetIsClean && configStatus.tokenPresent,
    historicalBackfillDisabled: configStatus.historicalBackfill === false,
    noExistingConversionJob: snapshot.jobs.length === 0,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    counts: {
      mqlTotal: snapshot.events.length,
      mqlHistoricalInvalidated: historicalMql.length,
      validMql: validMql.length,
      conversionJobs: snapshot.jobs.length,
      legacyDatasets: snapshot.legacyDatasets.length,
    },
  };
}

async function loadDryRun() {
  const configStatus = metaCleanConfigStatus();
  const snapshot = await getMetaCleanCanarySnapshot({
    leadId: LEAD_ID,
    datasetId: DATASET_ID,
  });
  return {
    configStatus,
    snapshot,
    validation: snapshotChecks(snapshot, configStatus),
  };
}

async function registerDataset() {
  const connections = await listMetaConnections();
  const candidates = connections.filter((connection) => (
    connection.active === true && connection.status === 'VALID'
  ));
  if (candidates.length !== 1) throw new Error('META_CLEAN_CONNECTION_NOT_UNIQUE');
  const connection = candidates[0];
  const dataset = await upsertMetaDataset({
    connectionId: connection.id,
    datasetId: DATASET_ID,
    name: DATASET_NAME,
    encryptedTestEventCode: null,
  });
  const details = await Promise.all(connections.map((item) => getMetaConnectionById(item.id)));
  let legacyDisabled = 0;
  for (const detail of details) {
    for (const item of detail?.datasets || []) {
      if (item.dataset_id !== META_LEGACY_DATASET_ID || item.active !== true) continue;
      if (await setMetaDatasetActive(item.id, false)) legacyDisabled += 1;
    }
  }
  console.log(JSON.stringify({
    mode: 'REGISTER',
    datasetId: DATASET_ID,
    datasetActive: dataset.active === true,
    connectionId: mask(connection.id),
    connectionStatus: connection.status,
    legacyDisabled,
    legacyFallback: false,
  }));
}

async function dryRun() {
  const result = await loadDryRun();
  console.log(JSON.stringify({
    mode: 'DRY_RUN',
    datasetId: DATASET_ID,
    leadId: mask(LEAD_ID),
    config: result.configStatus,
    validation: result.validation,
    writes: 0,
    eventsInserted: 0,
    jobsCreated: 0,
    graphPost: 0,
    confirmationId: result.snapshot.currentConfirmation
      ? mask(result.snapshot.currentConfirmation.id)
      : null,
  }));
  if (!result.validation.ok) process.exitCode = 1;
}

async function send() {
  const result = await loadDryRun();
  if (!result.validation.ok) {
    console.log(JSON.stringify({
      mode: 'SEND_BLOCKED',
      datasetId: DATASET_ID,
      leadId: mask(LEAD_ID),
      validation: result.validation,
      graphPost: 0,
    }));
    process.exitCode = 1;
    return;
  }

  const confirmation = result.snapshot.currentConfirmation;
  const created = await createMetaCleanCanaryEvent({
    leadId: LEAD_ID,
    datasetId: DATASET_ID,
    eventTime: confirmation.observed_at,
    confirmationId: confirmation.id,
    dryRun: false,
  });
  if (!created.event || !created.job) throw new Error('META_CLEAN_CANARY_EVENT_OR_JOB_MISSING');

  let response;
  try {
    response = await sendMetaCleanCanary({
      event_name: created.event.event_name,
      event_time: created.event.event_time,
      event_id: created.event.event_id,
      dataset_id: DATASET_ID,
      meta_lead_id: result.snapshot.lead.meta_lead_id,
    });
    const received = Number(response?.events_received);
    if (received !== 1) throw new Error('META_CLEAN_CANARY_EVENTS_RECEIVED_NOT_ONE');
    await markMetaEventSent(created.event.id, response, 1);
    await completeJob(created.job.id);
    console.log(JSON.stringify({
      mode: 'SEND',
      datasetId: DATASET_ID,
      leadId: mask(LEAD_ID),
      eventName: created.event.event_name,
      eventId: mask(created.event.event_id),
      httpStatus: 200,
      events_received: received,
      messages: Array.isArray(response?.messages) ? response.messages : [],
      fbtrace_id: response?.fbtrace_id || null,
      attempts: 1,
      eventCreated: true,
      jobCreated: true,
      jobCompleted: true,
      graphPost: 1,
      retry: false,
    }));
  } catch (error) {
    const sanitized = safeError(error);
    await markMetaEventFailed(created.event.id, sanitized.code, 1, false);
    await failJob(created.job.id, sanitized.code);
    console.log(JSON.stringify({
      mode: 'SEND_FAILED',
      datasetId: DATASET_ID,
      leadId: mask(LEAD_ID),
      eventId: mask(created.event.event_id),
      ...sanitized,
      attempts: 1,
      graphPost: 1,
      retry: false,
    }));
    process.exitCode = 1;
  }
}

const mode = process.argv[2];
try {
  if (mode === '--register') await registerDataset();
  else if (mode === '--dry-run') await dryRun();
  else if (mode === '--send') await send();
  else {
    console.error('Uso: node scripts/meta-clean-canary.mjs --register|--dry-run|--send');
    process.exitCode = 2;
  }
} catch (error) {
  console.log(JSON.stringify({ mode: 'ERROR', ...safeError(error) }));
  process.exitCode = 1;
} finally {
  await closePool();
}
