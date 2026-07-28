import crypto from 'node:crypto';

export const WA2_STAGE_LABEL_NAMES = Object.freeze({
  NEW: 'CRM 01 Em atendimento',
  CONTACT_STARTED: 'CRM 01 Em atendimento',
  NO_RESPONSE: 'CRM 01 Em atendimento',
  IN_SERVICE: 'CRM 01 Em atendimento',
  QUALIFIED: 'CRM 02 Qualificado',
  OPPORTUNITY: 'CRM 04 Oportunidade',
  NEGOTIATING: 'CRM 04 Oportunidade',
  AWAITING_ENROLLMENT: 'CRM 04 Oportunidade',
  AWAITING_PAYMENT: 'CRM 04 Oportunidade',
  LOST: 'CRM 99 Perdido',
  NO_INTEREST: 'CRM 99 Perdido',
  INVALID_PHONE: 'CRM 99 Perdido',
  DUPLICATED: 'CRM 99 Perdido',
});

export const WA2_LABEL_STAGES = Object.freeze(Object.keys(WA2_STAGE_LABEL_NAMES));
export const WA2_REMOTE_CONFIRM_DELAY_MS = 15_000;

export function getWa2StageLabelName(stage) {
  return WA2_STAGE_LABEL_NAMES[stage] || null;
}

export function normalizeWa2LabelName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function isWa2LabelStage(stage) {
  return Object.hasOwn(WA2_STAGE_LABEL_NAMES, stage);
}

export function stagesSharingWa2Label(stage) {
  const name = getWa2StageLabelName(stage);
  if (!name) return [];
  return WA2_LABEL_STAGES.filter((candidate) => WA2_STAGE_LABEL_NAMES[candidate] === name);
}

export function planWa2LabelMutations({
  currentLabelIds,
  knownCrmLabelIds,
  targetLabelId,
}) {
  const current = new Set(currentLabelIds);
  const known = new Set(knownCrmLabelIds);
  return {
    apply: current.has(targetLabelId) ? [] : [targetLabelId],
    remove: [...current].filter(
      (labelId) => labelId !== targetLabelId && known.has(labelId),
    ),
  };
}

export function wa2LabelIdempotencyKey(jobId, operation, labelId) {
  const digest = crypto.createHash('sha256')
    .update(`${jobId}:${operation}:${labelId}`)
    .digest('hex');
  return `crm-label:${digest}`;
}

function wa2LabelStateIsConfirmed({
  labelIds,
  knownCrmLabelIds,
  targetLabelId,
  requiredExternalLabelIds = [],
}) {
  const labels = new Set(labelIds);
  const known = new Set(knownCrmLabelIds);
  return (
    labels.has(targetLabelId) &&
    [...labels].every(
      (labelId) => !known.has(labelId) || labelId === targetLabelId,
    ) &&
    requiredExternalLabelIds.every((labelId) => labels.has(labelId))
  );
}

export async function synchronizeWa2LabelJob(job, client) {
  const currentLabels = await client.listWa2ChatLabels(
    job.remote_instance_id,
    job.remote_chat_id,
  );
  const plan = planWa2LabelMutations({
    currentLabelIds: currentLabels.map((label) => label.id),
    knownCrmLabelIds: job.known_remote_label_ids,
    targetLabelId: job.target_remote_label_id,
  });
  if (
    wa2LabelStateIsConfirmed({
      labelIds: currentLabels.map((label) => label.id),
      knownCrmLabelIds: job.known_remote_label_ids,
      targetLabelId: job.target_remote_label_id,
    })
  ) {
    return {
      applied: 0,
      removed: 0,
      alreadyCorrect: true,
      mutationEnqueued: false,
      confirmed: true,
      remotePending: false,
    };
  }
  const known = new Set(job.known_remote_label_ids);
  const externalLabelIds = currentLabels
    .map((label) => label.id)
    .filter((labelId) => !known.has(labelId));
  const mutationResults = [];
  for (const labelId of plan.apply) {
    mutationResults.push(await client.applyWa2ChatLabel(
      job.remote_instance_id,
      job.remote_chat_id,
      labelId,
      { idempotencyKey: wa2LabelIdempotencyKey(job.id, 'apply', labelId) },
    ));
  }
  for (const labelId of plan.remove) {
    mutationResults.push(await client.removeWa2ChatLabel(
      job.remote_instance_id,
      job.remote_chat_id,
      labelId,
      { idempotencyKey: wa2LabelIdempotencyKey(job.id, 'remove', labelId) },
    ));
  }
  const verifiedLabels = await client.listWa2ChatLabels(
    job.remote_instance_id,
    job.remote_chat_id,
  );
  const confirmed = wa2LabelStateIsConfirmed({
    labelIds: verifiedLabels.map((label) => label.id),
    knownCrmLabelIds: job.known_remote_label_ids,
    targetLabelId: job.target_remote_label_id,
    requiredExternalLabelIds: externalLabelIds,
  });
  return {
    applied: plan.apply.length,
    removed: plan.remove.length,
    alreadyCorrect: false,
    mutationEnqueued: mutationResults.some((result) => result.enqueued === true),
    confirmed,
    remotePending: !confirmed,
  };
}

export function wa2LabelJobCompletionDecision(
  syncResult,
  job,
  { now = Date.now() } = {},
) {
  if (syncResult.confirmed) return { status: 'DONE' };
  if (job.attempts >= job.max_attempts) {
    return {
      status: 'FAILED',
      error: {
        code: 'WA2_LABEL_SYNC_NOT_CONFIRMED',
        message: 'O estado final da etiqueta não foi confirmado no WA2.',
      },
    };
  }
  return {
    status: 'PENDING',
    availableAt: new Date(now + WA2_REMOTE_CONFIRM_DELAY_MS),
    pendingCode: 'WA2_REMOTE_PENDING',
  };
}

export function wa2LabelRetryDelayMs(attempts) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  return delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
}

export function isTemporaryWa2LabelError(error) {
  return (
    ['WA2_TIMEOUT', 'WA2_UNAVAILABLE'].includes(error?.code) ||
    error?.status === 408 ||
    error?.status === 409 ||
    error?.status === 429 ||
    (Number.isInteger(error?.status) && error.status >= 500)
  );
}

export function sanitizeWa2LabelJobError(error) {
  const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(error?.remoteCode || error?.code || ''))
    ? String(error.remoteCode || error.code)
    : 'WA2_LABEL_SYNC_FAILED';
  const message = String(error?.message || 'Falha ao sincronizar etiqueta WA2')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  return { code, message };
}
