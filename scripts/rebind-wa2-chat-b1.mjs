import 'dotenv/config';
import {
  closePool,
  getActiveWa2ContactLinkForLead,
  getLeadById,
  listVerifiedWhatsAppIdentitiesForLead,
  listWa2InstancesLocal,
  rebindVerifiedWa2IdentityToChat,
} from '../src/db.js';
import {
  getWa2ContactByPhone,
  listWa2ChatMessages,
} from '../src/wa2.js';
import {
  WA2_CHAT_REBIND_REASON,
  sha256,
} from '../src/wa2-rebind.js';

const LEAD_ID = 'ddf808e4-02b9-40b1-886d-2ee79dd2003e';
const INSTANCE_NAME = '2298 UNIVC';
const EVIDENCE_MARKER = 'TESTE NOVA SESSÃO WA 5846 B1';

function fail(message) {
  throw new Error(message);
}

async function loadSnapshot() {
  const lead = await getLeadById(LEAD_ID);
  if (!lead) fail('Lead de rebind não encontrado');
  const instances = await listWa2InstancesLocal({ enabledOnly: true });
  const instanceMatches = instances.filter((item) => item.name === INSTANCE_NAME);
  if (instanceMatches.length !== 1) fail('Instância de rebind não é única');
  const instance = instanceMatches[0];
  const currentLink = await getActiveWa2ContactLinkForLead(LEAD_ID, instance.id);
  if (!currentLink) fail('Vínculo ativo de rebind ausente');
  const identities = await listVerifiedWhatsAppIdentitiesForLead(LEAD_ID);
  if (identities.length !== 1) fail('Identidade verificada de rebind não é única');
  const identity = identities[0];
  const canonicalPhone = identity.canonical_phone;
  const resolved = await getWa2ContactByPhone(instance.remote_instance_id, canonicalPhone);
  if (!resolved?.contact?.id || !resolved?.contact?.jid || !resolved?.chat?.id) {
    fail('Contato ou chat B1 não resolvido pelo adaptador WA2');
  }
  if (!String(resolved.chat.jid).toLowerCase().endsWith('@lid')) {
    fail('Chat B1 não possui LID determinístico');
  }
  const messagesPage = await listWa2ChatMessages(
    instance.remote_instance_id,
    resolved.chat.id,
    { limit: 100 },
  );
  const matches = messagesPage.messages.filter((message) => message.text === EVIDENCE_MARKER);
  if (matches.length !== 1) fail('Evidência B1 não é única no chat resolvido');
  const message = matches[0];
  if (message.fromMe !== false) fail('Evidência B1 não é inbound');
  const observedAt = message.timestamp || message.createdAt;
  if (!observedAt) fail('Evidência B1 sem timestamp');
  const evidence = {
    adapterValidated: true,
    instanceId: instance.remote_instance_id,
    chatId: resolved.chat.id,
    contactId: resolved.contact.id,
    waMessageId: message.waMessageId,
    fromMe: message.fromMe,
    observedAt,
    lidJid: resolved.chat.jid,
    phoneJid: resolved.contact.jid,
  };
  const idempotencyKey = `wa2-rebind:${LEAD_ID}:${instance.id}:${sha256(message.waMessageId)}`;
  return {
    requestedTenantId: process.env.DEFAULT_TENANT_ID || 'super-educar',
    lead,
    instance,
    currentLink,
    identity,
    resolved,
    message,
    evidence,
    canonicalPhone,
    idempotencyKey,
  };
}

function actionInput(snapshot) {
  return {
    requestedTenantId: snapshot.requestedTenantId,
    leadId: LEAD_ID,
    instanceId: snapshot.instance.id,
    expectedActiveLinkId: snapshot.currentLink.id,
    expectedOldRemoteChatId: snapshot.currentLink.remote_chat_id,
    newRemoteChatId: snapshot.resolved.chat.id,
    newRemoteContactId: snapshot.resolved.contact.id,
    newRemoteJid: snapshot.resolved.contact.jid,
    canonicalPhone: snapshot.canonicalPhone,
    pn: snapshot.resolved.contact.jid,
    lid: snapshot.resolved.chat.jid,
    evidenceWaMessageId: snapshot.message.waMessageId,
    evidenceTimestamp: snapshot.evidence.observedAt,
    evidence: snapshot.evidence,
    reason: WA2_CHAT_REBIND_REASON,
    actor: 'system:wa2-rebind-b1',
    idempotencyKey: snapshot.idempotencyKey,
  };
}

const mode = process.argv[2];
if (!['--dry-run', '--execute'].includes(mode)) {
  console.error('Uso: node scripts/rebind-wa2-chat-b1.mjs --dry-run|--execute');
  process.exitCode = 2;
} else {
  try {
    const snapshot = await loadSnapshot();
    const result = await rebindVerifiedWa2IdentityToChat({
      ...actionInput(snapshot),
      dryRun: mode === '--dry-run',
    });
    console.log(JSON.stringify({
      mode: mode === '--dry-run' ? 'DRY_RUN' : 'EXECUTE',
      status: result.status,
      classification: result.classification || 'A',
      evidence: 'VALIDATED_BY_WA2_ADAPTER',
      messageCount: 1,
      inbound: true,
      idempotencyKeyPresent: true,
      idempotent: result.idempotent === true,
      currentActiveLinks: result.currentActiveLinks ?? (result.status === 'ALREADY_REBOUND' ? 1 : undefined),
      newChatActiveLinks: result.newChatActiveLinks ?? (result.status === 'ALREADY_REBOUND' ? 1 : undefined),
      historyCreated: result.wouldCreateHistory === 1 || Boolean(result.historyId),
      stageChanged: result.wouldChangeStage === true,
      metaCreated: result.wouldCreateMeta === true,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      status: 'ERROR',
      code: /^[A-Z0-9_.:-]{1,80}$/.test(String(error?.code || '')) ? error.code : 'WA2_REBIND_FAILED',
      message: 'Rebind não executado; pré-condição rejeitada.',
    }));
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
