import 'dotenv/config';
import {
  closePool,
  confirmCurrentWa2LabelStateAndAlignLead,
  getActiveWa2ContactLinkForLead,
  getLeadById,
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
import { WA2_NORMAL_CHAT_REBIND_REASON } from '../src/wa2-rebind.js';

const LEAD_ID = 'a1d7206f-4de2-4205-95d5-de3184904940';
const INSTANCE_NAME = '2298 UNIVC';
const REMOTE_LABEL_ID = '36';
const REMOTE_LABEL_NAME = 'CRM 02 - Qualificado';
const EXPECTED_CURRENT_CHAT_ID = 'cmseyqql503r3nn0t9qxfaqy1';
const EXPECTED_CURRENT_CONTACT_ID = 'cmseyrlr40n4qnn0t6pg58x1p';
const EXPECTED_APPLY_EVENT_ID = 'fd402cac-8777-4c2a-a623-7f44775619e0';
const REBIND_IDEMPOTENCY_KEY = `wa2-normal-rebind:${LEAD_ID}:crm02-current-v1`;
const CONFIRMATION_IDEMPOTENCY_KEY = `wa2-current-label:${LEAD_ID}:crm02-v1`;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function masked(value) {
  const text = String(value || '');
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

async function loadSnapshot({ allowAligned = false } = {}) {
  const lead = await getLeadById(LEAD_ID);
  if (!lead) fail('LEAD_NOT_FOUND');
  if (lead.tenant_id !== (process.env.DEFAULT_TENANT_ID || 'super-educar')) fail('TENANT_MISMATCH');
  if (lead.stage !== 'NEW' && !(allowAligned && lead.stage === 'QUALIFIED')) fail('STAGE_NOT_NEW');
  if (lead.is_internal_test === true) fail('INTERNAL_TEST_NOT_ALLOWED');
  if (!lead.meta_lead_id) fail('META_LEAD_ID_MISSING');

  const instances = (await listWa2InstancesLocal({ enabledOnly: true }))
    .filter((item) => item.name === INSTANCE_NAME);
  if (instances.length !== 1) fail('INSTANCE_NOT_UNIQUE');
  const instance = instances[0];
  const activeLink = await getActiveWa2ContactLinkForLead(LEAD_ID, instance.id);
  if (!activeLink) fail('LEGACY_LINK_MISSING');
  if (activeLink.remote_chat_id === EXPECTED_CURRENT_CHAT_ID) fail('LEGACY_LINK_ALREADY_CURRENT');

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
  const officialStageLabels = labels.filter((label) => ['57', '36', '63', '68', '67', '35'].includes(label.id));
  if (officialStageLabels.length !== 1 || officialStageLabels[0].id !== REMOTE_LABEL_ID) {
    fail('CURRENT_OFFICIAL_LABEL_NOT_EXCLUSIVE');
  }

  const feed = await listWa2LabelEvents({ limit: 200 });
  const matches = feed.events.filter((event) => (
    event.eventId === EXPECTED_APPLY_EVENT_ID &&
    event.instanceId === instance.remote_instance_id &&
    event.chatId === EXPECTED_CURRENT_CHAT_ID &&
    event.waLabelId === REMOTE_LABEL_ID &&
    event.operation === 'APPLY' &&
    event.source === 'WHATSAPP' &&
    event.eligibleForCrm === true
  ));
  if (matches.length !== 1) fail('APPLY_EVENT_NOT_UNIQUE');
  const event = matches[0];
  if (resolved.contact.phoneNormalized !== identity.canonicalE164) fail('PN_CANONICAL_MISMATCH');

  return {
    lead,
    instance,
    activeLink,
    resolved,
    identity,
    event,
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
      operation: event.operation,
      evidenceType: 'WA2_LABEL_APPLY_EVENT',
      evidenceReference: event.eventId,
      sourceEventId: event.eventId,
      observedAt: event.observedAt,
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

async function execute(mode) {
  const snapshot = await loadSnapshot();
  const rebind = await rebindNormalLeadToCurrentWa2Chat({
    ...snapshot.rebindInput,
    dryRun: mode === '--dry-run',
  });
  if (mode === '--dry-run') {
    console.log(JSON.stringify({
      mode: 'DRY_RUN',
      rebind: rebind.status,
      classification: rebind.classification,
      eventApplyPresent: true,
      officialLabelCurrent: true,
      messageRequired: false,
      waMessageIdCreated: false,
      receiptCreated: false,
      stageChange: false,
      metaCreated: false,
    }));
    return;
  }

  const identityResult = await verifyExistingWa2Identity({
    leadId: LEAD_ID,
    instanceId: snapshot.instance.id,
    expectedPhoneNormalized: snapshot.identity.canonicalE164,
    resolved: snapshot.resolved,
    evidence: identityEvidence(snapshot),
    actor: 'system:wa2-normal-identity',
  });
  if (!['ALREADY_VERIFIED', undefined].includes(identityResult.classification)
    && identityResult.idempotent !== false) fail('IDENTITY_RESULT_INVALID');
  const verifiedIdentity = identityResult.identity;
  if (!verifiedIdentity) fail('IDENTITY_NOT_CREATED');
  const currentLink = await getActiveWa2ContactLinkForLead(LEAD_ID, snapshot.instance.id);
  if (!currentLink || currentLink.remote_chat_id !== EXPECTED_CURRENT_CHAT_ID) fail('CURRENT_LINK_NOT_ACTIVE');

  const confirmation = await confirmCurrentWa2LabelStateAndAlignLead({
    requestedTenantId: snapshot.lead.tenant_id,
    leadId: LEAD_ID,
    instanceId: snapshot.instance.id,
    remoteInstanceId: snapshot.instance.remote_instance_id,
    activeLinkId: currentLink.id,
    verifiedIdentityId: verifiedIdentity.id,
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
  });

  const repeatSnapshot = await loadSnapshot({ allowAligned: true });
  const repeatRebind = await rebindNormalLeadToCurrentWa2Chat({
    ...repeatSnapshot.rebindInput,
    dryRun: false,
  });
  const repeatIdentity = await verifyExistingWa2Identity({
    leadId: LEAD_ID,
    instanceId: repeatSnapshot.instance.id,
    expectedPhoneNormalized: repeatSnapshot.identity.canonicalE164,
    resolved: repeatSnapshot.resolved,
    evidence: identityEvidence(repeatSnapshot),
    actor: 'system:wa2-normal-identity',
  });
  const repeatLink = await getActiveWa2ContactLinkForLead(LEAD_ID, repeatSnapshot.instance.id);
  const repeatConfirmation = await confirmCurrentWa2LabelStateAndAlignLead({
    requestedTenantId: repeatSnapshot.lead.tenant_id,
    leadId: LEAD_ID,
    instanceId: repeatSnapshot.instance.id,
    remoteInstanceId: repeatSnapshot.instance.remote_instance_id,
    activeLinkId: repeatLink.id,
    verifiedIdentityId: repeatIdentity.identity.id,
    remoteChatId: repeatSnapshot.resolved.chat.id,
    remoteContactId: repeatSnapshot.resolved.contact.id,
    remoteLabelId: REMOTE_LABEL_ID,
    remoteLabelName: REMOTE_LABEL_NAME,
    operation: repeatSnapshot.event.operation,
    evidenceType: 'WA2_LABEL_APPLY_EVENT',
    evidenceReference: repeatSnapshot.event.eventId,
    sourceEventId: repeatSnapshot.event.eventId,
    observedAt: repeatSnapshot.event.observedAt,
    actor: 'system:wa2-current-label-crm02',
    idempotencyKey: CONFIRMATION_IDEMPOTENCY_KEY,
  });
  console.log(JSON.stringify({
    mode: 'EXECUTE',
    rebind: rebind.status,
    identity: identityResult.classification || 'VERIFIED',
    confirmation: confirmation.status,
    stage: confirmation.stageStatus || 'ALIGNED',
    repeatRebind: repeatRebind.status,
    repeatIdentity: repeatIdentity.classification || 'ALREADY_VERIFIED',
    repeatConfirmation: repeatConfirmation.status,
    currentActiveLinks: 1,
    waMessageIdCreated: false,
    receiptCreated: false,
    metaCreated: false,
    graphPost: 0,
    lead: masked(LEAD_ID),
  }));
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
      code: /^[A-Z0-9_.:-]{1,100}$/.test(String(error?.code || '')) ? error.code : 'WA2_NORMAL_REBIND_FAILED',
      message: 'Operação não concluída; nenhuma tentativa adicional foi feita.',
    }));
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
