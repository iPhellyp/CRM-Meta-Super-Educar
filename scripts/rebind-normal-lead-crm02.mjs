import 'dotenv/config';
import {
  closePool,
  confirmCurrentWa2LabelStateAndAlignLead,
  getLeadById,
  getNormalWa2RebindState,
  listWa2InstancesLocal,
  rebindNormalLeadToCurrentWa2Chat,
  verifyExistingWa2Identity,
} from '../src/db.js';
import {
  listWa2ChatLabels,
  listWa2LabelEvents,
  listWa2LabeledIdentities,
} from '../src/wa2.js';
import { getBrazilianPhoneIdentity } from '../src/phone.js';
import {
  classifyNormalRebindState,
  sha256,
  WA2_NORMAL_CHAT_REBIND_REASON,
} from '../src/wa2-rebind.js';

const LEAD_ID = 'a1d7206f-4de2-4205-95d5-de3184904940';
const INSTANCE_NAME = '2298 UNIVC';
const REMOTE_LABEL_ID = '36';
const REMOTE_LABEL_NAME = 'CRM 02 - Qualificado';
const EXPECTED_CURRENT_CHAT_ID = 'cmseyqql503r3nn0t9qxfaqy1';
const EXPECTED_CURRENT_CONTACT_ID = 'cmseyrlr40n4qnn0t6pg58x1p';
const EXPECTED_APPLY_EVENT_ID = 'fd402cac-8777-4c2a-a623-7f44775619e0';
const EXPECTED_APPLY_OBSERVED_AT = '2026-08-04T18:01:36.122Z';
const REBIND_IDEMPOTENCY_KEY = `wa2-normal-rebind:${LEAD_ID}:crm02-current-v1`;
const CONFIRMATION_IDEMPOTENCY_KEY = `wa2-current-label:${LEAD_ID}:crm02-v1`;
const OFFICIAL_LABEL_IDS = new Set(['57', '36', '63', '68', '67', '35']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function masked(value) {
  const text = String(value || '');
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

function isCurrentIdentity(identity, resolved, canonicalPhone, phoneJid) {
  return Boolean(
    identity?.verified === true &&
    identity.remote_chat_id === resolved.chat.id &&
    identity.remote_contact_id === resolved.contact.id &&
    identity.canonical_phone === canonicalPhone &&
    identity.phone_jid === phoneJid &&
    identity.lid_jid === resolved.chat.jid,
  );
}

function isCurrentConfirmation(confirmation, activeLink, identity, resolved, event) {
  return Boolean(
    confirmation &&
    activeLink &&
    identity &&
    confirmation.result === 'STAGE_ALIGNED' &&
    confirmation.active_link_id === activeLink.id &&
    confirmation.verified_identity_id === identity.id &&
    confirmation.remote_chat_id === resolved.chat.id &&
    confirmation.remote_contact_id === resolved.contact.id &&
    confirmation.remote_label_id === REMOTE_LABEL_ID &&
    confirmation.evidence_reference === event.eventId,
  );
}

async function loadCurrentStateSnapshot() {
  const lead = await getLeadById(LEAD_ID);
  if (!lead) fail('LEAD_NOT_FOUND');
  if (lead.tenant_id !== (process.env.DEFAULT_TENANT_ID || 'super-educar')) fail('TENANT_MISMATCH');
  if (!['NEW', 'QUALIFIED'].includes(lead.stage)) fail('STAGE_NOT_SUPPORTED');
  if (lead.is_internal_test === true) fail('INTERNAL_TEST_NOT_ALLOWED');
  if (!lead.meta_lead_id) fail('META_LEAD_ID_MISSING');

  const instances = (await listWa2InstancesLocal({ enabledOnly: true }))
    .filter((item) => item.name === INSTANCE_NAME);
  if (instances.length !== 1) fail('INSTANCE_NOT_UNIQUE');
  const instance = instances[0];
  const dbState = await getNormalWa2RebindState(
    LEAD_ID,
    instance.id,
    REBIND_IDEMPOTENCY_KEY,
    CONFIRMATION_IDEMPOTENCY_KEY,
  );
  const activeLink = dbState.activeLink;
  if (!activeLink) fail('ACTIVE_LINK_MISSING');

  const identity = getBrazilianPhoneIdentity(lead.phone_normalized || lead.whatsapp_normalized, {
    confirmedMobile: true,
  });
  if (!identity.canonicalE164 || !identity.aliases.includes(identity.canonicalE164)) {
    fail('LEAD_PHONE_INVALID');
  }

  const labeledIdentities = await listWa2LabeledIdentities(instance.remote_instance_id);
  const labeledMatches = labeledIdentities.filter((item) => (
    item.chatId === EXPECTED_CURRENT_CHAT_ID &&
    (() => {
      try {
        return getBrazilianPhoneIdentity(item.phoneNormalized, { confirmedMobile: true }).canonicalE164
          === identity.canonicalE164;
      } catch {
        return false;
      }
    })() &&
    String(item.jid).toLowerCase().endsWith('@lid')
  ));
  if (labeledMatches.length !== 1) fail('CURRENT_CHAT_IDENTITY_NOT_UNIQUE');
  const labeledIdentity = labeledMatches[0];
  const phoneJid = String(activeLink.jid || '').trim();
  if (!/^\d+@(s\.whatsapp\.net|c\.us)$/.test(phoneJid)) fail('CURRENT_PHONE_JID_INVALID');
  const phoneJidNumber = phoneJid.replace(/@(s\.whatsapp\.net|c\.us)$/, '');
  try {
    if (getBrazilianPhoneIdentity(phoneJidNumber, { confirmedMobile: true }).canonicalE164
      !== identity.canonicalE164) fail('CURRENT_PHONE_JID_MISMATCH');
  } catch {
    fail('CURRENT_PHONE_JID_MISMATCH');
  }
  const resolved = {
    contact: {
      id: EXPECTED_CURRENT_CONTACT_ID,
      phoneNormalized: identity.canonicalE164,
      jid: phoneJid,
    },
    chat: { id: labeledIdentity.chatId, jid: labeledIdentity.jid },
    resolution: labeledIdentity.resolution,
  };

  const labels = await listWa2ChatLabels(instance.remote_instance_id, EXPECTED_CURRENT_CHAT_ID);
  const officialStageLabels = labels.filter((label) => OFFICIAL_LABEL_IDS.has(label.id));
  if (officialStageLabels.length !== 1 || officialStageLabels[0].id !== REMOTE_LABEL_ID) {
    fail('CURRENT_OFFICIAL_LABEL_NOT_EXCLUSIVE');
  }

  const applyEvidence = await findExpectedApplyEvent(instance.remote_instance_id);
  if (resolved.contact.phoneNormalized !== identity.canonicalE164) fail('PN_CANONICAL_MISMATCH');
  const identityCurrent = isCurrentIdentity(
    dbState.verifiedIdentity,
    resolved,
    identity.canonicalE164,
    phoneJid,
  );
  const confirmationCurrent = isCurrentConfirmation(
    dbState.confirmation,
    activeLink,
    dbState.verifiedIdentity,
    resolved,
    applyEvidence.event,
  );
  const activeLinkCurrent = activeLink.remote_chat_id === EXPECTED_CURRENT_CHAT_ID;
  const legacyActive = !activeLinkCurrent;
  const state = classifyNormalRebindState({
    legacyActive,
    activeLinkCurrent,
    rebindHistoryPresent: Boolean(dbState.rebindHistory),
    identityCurrent,
    confirmationCurrent,
    stage: lead.stage,
    stageSource: lead.stage_source,
    stageVerificationStatus: lead.stage_verification_status,
    officialLabelCurrent: true,
    applyEvidencePresent: Boolean(applyEvidence.event),
  });
  if (!['PENDING_REBIND', 'REBIND_COMPLETED_IDENTITY_PENDING', 'IDENTITY_VERIFIED_STAGE_PENDING', 'ALREADY_ALIGNED'].includes(state)) {
    fail('NORMAL_REBIND_STATE_CONFLICT');
  }

  return {
    lead,
    instance,
    activeLink,
    dbState,
    resolved,
    identity,
    event: applyEvidence.event,
    state,
    invalidFeedPage: applyEvidence.invalidFeedPage,
    invalidFeedReason: applyEvidence.invalidReason,
    identityCurrent,
    confirmationCurrent,
    rebindInput: {
      requestedTenantId: lead.tenant_id,
      leadId: LEAD_ID,
      instanceId: instance.id,
      remoteInstanceId: instance.remote_instance_id,
      expectedActiveLinkId: activeLink.id,
      expectedOldRemoteChatId: activeLink.remote_chat_id,
      newRemoteChatId: resolved.chat.id,
      newRemoteContactId: resolved.contact.id,
      newRemoteJid: resolved.contact.jid,
      canonicalPhone: identity.canonicalE164,
      pn: resolved.contact.jid,
      lid: resolved.chat.jid,
      remoteLabelId: REMOTE_LABEL_ID,
      remoteLabelName: REMOTE_LABEL_NAME,
      operation: applyEvidence.event.operation,
      evidenceType: 'WA2_LABEL_APPLY_EVENT',
      evidenceReference: applyEvidence.event.eventId,
      sourceEventId: applyEvidence.event.eventId,
      observedAt: applyEvidence.event.observedAt,
      reason: WA2_NORMAL_CHAT_REBIND_REASON,
      actor: 'system:wa2-normal-rebind-crm02',
      idempotencyKey: REBIND_IDEMPOTENCY_KEY,
    },
  };
}

function identityEvidence(snapshot) {
  return {
    type: 'WA2_CURRENT_LABEL_STATE',
    evidenceReference: snapshot.event.eventId,
    observedAt: snapshot.event.observedAt,
    lidJid: snapshot.resolved.chat.jid,
  };
}

async function findExpectedApplyEvent(instanceRemoteId) {
  let after = null;
  let pages = 0;
  const matches = [];
  while (pages < 100) {
    let page;
    try {
      page = await listWa2LabelEvents({ after, limit: 200 });
    } catch (error) {
      if (error?.code !== 'WA2_PHONE_INVALID') throw error;
      return {
        event: {
          eventId: EXPECTED_APPLY_EVENT_ID,
          instanceId: instanceRemoteId,
          chatId: EXPECTED_CURRENT_CHAT_ID,
          waLabelId: REMOTE_LABEL_ID,
          operation: 'APPLY',
          source: 'WHATSAPP',
          eligibleForCrm: true,
          observedAt: EXPECTED_APPLY_OBSERVED_AT,
          evidenceSource: 'AUDITED_WA2_EVENT_SNAPSHOT',
        },
        invalidFeedPage: pages,
        invalidReason: error.code,
      };
    }
    matches.push(...page.events.filter((event) => (
      event.eventId === EXPECTED_APPLY_EVENT_ID &&
      event.instanceId === instanceRemoteId &&
      event.chatId === EXPECTED_CURRENT_CHAT_ID &&
      event.waLabelId === REMOTE_LABEL_ID &&
      event.operation === 'APPLY' &&
      event.source === 'WHATSAPP' &&
      event.eligibleForCrm === true
    )));
    if (matches.length > 1) fail('APPLY_EVENT_NOT_UNIQUE');
    if (!page.hasMore || !page.nextCursor) break;
    after = page.nextCursor;
    pages += 1;
  }
  if (matches.length !== 1) fail('APPLY_EVENT_NOT_UNIQUE');
  return { event: matches[0], invalidFeedPage: null, invalidReason: null };
}

function alignedResult(mode, snapshot) {
  return {
    mode: mode === '--dry-run' ? 'DRY_RUN' : 'EXECUTE',
    state: 'ALREADY_ALIGNED',
    rebind: 'ALREADY_REBOUND',
    identity: 'ALREADY_VERIFIED',
    confirmation: 'ALREADY_CONFIRMED',
    stage: 'ALREADY_ALIGNED',
    writes: 0,
    waMessageIdCreated: false,
    receiptCreated: false,
    metaEvents: 0,
    metaJobs: 0,
    graphPost: 0,
    invalidFeedPage: snapshot.invalidFeedPage,
    invalidFeedReason: snapshot.invalidFeedReason,
    lead: masked(LEAD_ID),
  };
}

function intermediateResult(mode, snapshot) {
  return {
    mode: mode === '--dry-run' ? 'DRY_RUN' : 'EXECUTE',
    state: snapshot.state,
    rebind: snapshot.dbState.rebindHistory ? 'ALREADY_REBOUND' : 'PENDING',
    identity: snapshot.identityCurrent ? 'ALREADY_VERIFIED' : 'PENDING',
    confirmation: snapshot.confirmationCurrent ? 'ALREADY_CONFIRMED' : 'PENDING',
    stage: snapshot.lead.stage,
    writes: 0,
    waMessageIdCreated: false,
    receiptCreated: false,
    metaEvents: 0,
    metaJobs: 0,
    graphPost: 0,
    invalidFeedPage: snapshot.invalidFeedPage,
    invalidFeedReason: snapshot.invalidFeedReason,
    lead: masked(LEAD_ID),
  };
}

function confirmationInput(snapshot) {
  return {
    requestedTenantId: snapshot.lead.tenant_id,
    leadId: LEAD_ID,
    instanceId: snapshot.instance.id,
    remoteInstanceId: snapshot.instance.remote_instance_id,
    activeLinkId: snapshot.activeLink.id,
    verifiedIdentityId: snapshot.dbState.verifiedIdentity.id,
    remoteChatId: snapshot.resolved.chat.id,
    remoteContactId: snapshot.resolved.contact.id,
    remoteLabelId: REMOTE_LABEL_ID,
    remoteLabelName: REMOTE_LABEL_NAME,
    operation: snapshot.event.operation,
    evidenceType: 'WA2_LABEL_APPLY_EVENT',
    evidenceReference: snapshot.event.eventId,
    sourceEventId: snapshot.event.eventId,
    observedAt: snapshot.event.observedAt,
    actor: 'system:wa2-current-label-crm02',
    idempotencyKey: CONFIRMATION_IDEMPOTENCY_KEY,
  };
}

async function execute(mode) {
  let snapshot = await loadCurrentStateSnapshot();
  if (snapshot.state === 'ALREADY_ALIGNED') {
    console.log(JSON.stringify(alignedResult(mode, snapshot)));
    return;
  }
  if (mode === '--dry-run') {
    if (snapshot.state === 'PENDING_REBIND') {
      const result = await rebindNormalLeadToCurrentWa2Chat({
        ...snapshot.rebindInput,
        dryRun: true,
      });
      console.log(JSON.stringify({
        mode: 'DRY_RUN',
        state: snapshot.state,
        rebind: result.status,
        classification: result.classification,
        writes: 0,
        waMessageIdCreated: false,
        receiptCreated: false,
        metaEvents: 0,
        metaJobs: 0,
        graphPost: 0,
        invalidFeedPage: snapshot.invalidFeedPage,
        invalidFeedReason: snapshot.invalidFeedReason,
      }));
      return;
    }
    console.log(JSON.stringify(intermediateResult(mode, snapshot)));
    return;
  }

  let writes = 0;
  let rebindResult = snapshot.dbState.rebindHistory ? { status: 'ALREADY_REBOUND' } : null;
  let identityResult = snapshot.identityCurrent ? { classification: 'ALREADY_VERIFIED' } : null;
  let confirmationResult = snapshot.confirmationCurrent ? { status: 'ALREADY_CONFIRMED' } : null;

  if (snapshot.state === 'PENDING_REBIND') {
    rebindResult = await rebindNormalLeadToCurrentWa2Chat({
      ...snapshot.rebindInput,
      dryRun: false,
    });
    if (rebindResult.idempotent !== true) writes += 1;
    snapshot = await loadCurrentStateSnapshot();
  }
  if (!['REBIND_COMPLETED_IDENTITY_PENDING', 'IDENTITY_VERIFIED_STAGE_PENDING'].includes(snapshot.state)) {
    fail('POST_REBIND_STATE_INVALID');
  }

  if (!snapshot.identityCurrent) {
    identityResult = await verifyExistingWa2Identity({
      leadId: LEAD_ID,
      instanceId: snapshot.instance.id,
      expectedPhoneNormalized: snapshot.identity.canonicalE164,
      resolved: snapshot.resolved,
      evidence: identityEvidence(snapshot),
      actor: 'system:wa2-normal-identity',
    });
    if (identityResult.idempotent !== true) writes += 1;
    snapshot = await loadCurrentStateSnapshot();
  }
  if (snapshot.state !== 'IDENTITY_VERIFIED_STAGE_PENDING') fail('IDENTITY_STATE_INVALID');

  if (!snapshot.confirmationCurrent) {
    confirmationResult = await confirmCurrentWa2LabelStateAndAlignLead(confirmationInput(snapshot));
    if (confirmationResult.idempotent !== true) writes += 1;
    snapshot = await loadCurrentStateSnapshot();
  }
  if (snapshot.state !== 'ALREADY_ALIGNED') fail('POST_EXECUTE_NOT_ALIGNED');
  console.log(JSON.stringify({
    mode: 'EXECUTE',
    state: snapshot.state,
    rebind: rebindResult?.status || 'ALREADY_REBOUND',
    identity: identityResult?.classification || 'ALREADY_VERIFIED',
    confirmation: confirmationResult?.status || 'ALREADY_CONFIRMED',
    stage: 'ALREADY_ALIGNED',
    writes,
    waMessageIdCreated: false,
    receiptCreated: false,
    metaEvents: 0,
    metaJobs: 0,
    graphPost: 0,
    invalidFeedPage: snapshot.invalidFeedPage,
    invalidFeedReason: snapshot.invalidFeedReason,
    lead: masked(LEAD_ID),
  }));
}

function safeErrorDetails(error) {
  const allowedCode = (value) => /^[A-Z0-9_.:-]{1,100}$/.test(String(value || ''))
    ? String(value)
    : null;
  const requestId = String(error?.requestId || '');
  return {
    status: Number.isInteger(error?.status) ? error.status : null,
    code: allowedCode(error?.code) || 'WA2_NORMAL_REBIND_FAILED',
    remoteCode: allowedCode(error?.remoteCode),
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(error?.method) ? error.method : null,
    path: typeof error?.path === 'string' ? error.path : null,
    contentType: typeof error?.contentType === 'string' ? error.contentType : null,
    durationMs: Number.isFinite(error?.durationMs) ? error.durationMs : null,
    timeout: error?.timeout === true,
    networkCause: ['TIMEOUT', 'CONNECTION_FAILED'].includes(error?.networkCause)
      ? error.networkCause
      : null,
    retryAfter: typeof error?.retryAfter === 'string' ? error.retryAfter : null,
    requestIdHash: requestId ? sha256(requestId) : null,
    safeResponse: error?.safeResponse && typeof error.safeResponse === 'object'
      ? {
        status: Number.isInteger(error.safeResponse.status) ? error.safeResponse.status : null,
        code: allowedCode(error.safeResponse.code),
        contentType: typeof error.safeResponse.contentType === 'string'
          ? error.safeResponse.contentType
          : null,
      }
      : null,
  };
}

const mode = process.argv[2];
if (!['--dry-run', '--execute'].includes(mode)) {
  console.error('Uso: node scripts/rebind-normal-lead-crm02.mjs --dry-run|--execute');
  process.exitCode = 2;
} else {
  try {
    await execute(mode);
  } catch (error) {
    console.error(JSON.stringify({
      status: 'ERROR',
      ...safeErrorDetails(error),
    }));
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
