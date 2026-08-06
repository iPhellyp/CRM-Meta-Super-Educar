import {
  getWa2InstanceReplacementInputs,
  listWa2LabelBindings,
  listWa2InstancesLocal,
  listWa2ReplacementNewState,
} from './db.js';
import {
  getWa2ContactByPhone,
  getWa2InstanceStatus,
  listWa2Labels,
} from './wa2.js';
import {
  normalizeCanonicalWhatsAppPhone,
  planWa2InstanceReplacement,
} from './wa2-instance-replacement.js';

async function statusOrNull(instance) {
  try {
    return await getWa2InstanceStatus(instance.remote_instance_id);
  } catch {
    return null;
  }
}

export async function collectWa2InstanceReplacementDryRun(oldInstanceId, newInstanceId) {
  const context = await getWa2InstanceReplacementInputs(oldInstanceId, newInstanceId);
  if (!context.oldInstance || !context.newInstance) {
    throw new Error('Instância local antiga ou nova não encontrada.');
  }
  const [oldStatus, newStatus, newLabels, newBindings, localInstances] = await Promise.all([
    statusOrNull(context.oldInstance),
    getWa2InstanceStatus(context.newInstance.remote_instance_id),
    listWa2Labels(context.newInstance.remote_instance_id),
    listWa2LabelBindings(context.newInstance.id),
    listWa2InstancesLocal(),
  ]);
  const newPhone = normalizeCanonicalWhatsAppPhone(newStatus.phone, { confirmedMobile: true });
  const activeSamePhone = localInstances.filter((instance) => (
    instance.enabled &&
    normalizeCanonicalWhatsAppPhone(instance.phone, { confirmedMobile: true }) === newPhone
  ));
  const candidatesByLeadId = {};
  for (const link of context.oldLinks) {
    const phone = normalizeCanonicalWhatsAppPhone(link.phone_normalized, { confirmedMobile: true });
    if (!phone) {
      candidatesByLeadId[link.lead_id] = [];
      continue;
    }
    try {
      const resolved = await getWa2ContactByPhone(context.newInstance.remote_instance_id, phone);
      const newState = await listWa2ReplacementNewState(
        context.newInstance.id,
        phone,
        resolved.chat?.id || null,
      );
      const existingLink = newState.links.find((item) => item.lead_id === link.lead_id) || null;
      candidatesByLeadId[link.lead_id] = [{
        leadId: link.lead_id,
        contactId: resolved.contact.id,
        chatId: resolved.chat?.id,
        phoneNormalized: resolved.contact.phoneNormalized,
        phoneJid: resolved.contact.jid,
        jid: resolved.chat?.jid || resolved.contact.jid,
        identityOwnerLeadId: newState.identities[0]?.lead_id || null,
        identityCount: Number(link.identity_count || 0),
        newIdentityCount: newState.identities.length,
        identityPresent: link.identity_id ? link.identity_verified === true : false,
        oldIdentityCanonicalPhone: normalizeCanonicalWhatsAppPhone(link.identity_canonical_phone, { confirmedMobile: true }),
        activeLinkLeadId: newState.links[0]?.lead_id || null,
        activeLinkCount: newState.links.length,
        alreadyAligned: Boolean(existingLink),
      }];
    } catch (error) {
      const isNotFound = error?.status === 404 || error?.remoteCode === 'CONTACT_NOT_FOUND';
      if (!isNotFound) throw error;
      candidatesByLeadId[link.lead_id] = [];
    }
  }
  const report = planWa2InstanceReplacement({
    tenantId: context.tenantId,
    oldInstance: context.oldInstance,
    newInstance: context.newInstance,
    oldStatus,
    newStatus,
    activeInstanceCount: activeSamePhone.length,
    oldLinks: context.oldLinks,
    candidatesByLeadId,
    newLabels,
    existingBindings: newBindings,
  });
  return { ...report, context, oldStatus, newStatus, activeSamePhone };
}
