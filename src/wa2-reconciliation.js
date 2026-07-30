export function wa2ReconciliationInstanceIds(instance) {
  if (!instance?.id) {
    const error = new Error('Instância local não encontrada');
    error.code = 'WA2_INSTANCE_NOT_FOUND';
    throw error;
  }
  if (!instance.enabled) {
    const error = new Error('Instância local está desabilitada');
    error.code = 'WA2_INSTANCE_DISABLED';
    throw error;
  }
  if (!instance.remote_instance_id) {
    const error = new Error('Instância local não possui ID remoto');
    error.code = 'WA2_REMOTE_INSTANCE_ID_MISSING';
    throw error;
  }
  return {
    localInstanceId: instance.id,
    remoteInstanceId: instance.remote_instance_id,
  };
}

export async function prepareWa2Reconciliation({
  ids,
  candidatePhones,
  health,
  getStatus,
  connect,
  quickSync,
  rebuild,
  getRebuildStatus,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  reconnectDeadlineMs = 60_000,
  rebuildDeadlineMs = 120_000,
}) {
  const service = await health();
  if (!service.ok) {
    const error = new Error('WA2 indisponível');
    error.code = 'WA2_TEMPORARY_FAILURE';
    throw error;
  }

  let status = await getStatus(ids.remoteInstanceId);
  if (status.status !== 'connected') {
    if (status.requiresQr) {
      const error = new Error('Instância WA2 requer QR');
      error.code = 'WA2_INSTANCE_REQUIRES_QR';
      throw error;
    }
    await connect(ids.remoteInstanceId, 'resume');
    const reconnectDeadline = Date.now() + reconnectDeadlineMs;
    while (Date.now() < reconnectDeadline) {
      await wait(2_000);
      status = await getStatus(ids.remoteInstanceId);
      if (status.status === 'connected') break;
      if (status.requiresQr) break;
    }
  }
  if (status.status !== 'connected') {
    const error = new Error('Instância WA2 ainda não está pronta');
    error.code = 'WA2_TEMPORARY_FAILURE';
    throw error;
  }

  await quickSync(ids.remoteInstanceId, 'quick');
  await rebuild(ids.remoteInstanceId, candidatePhones);
  const rebuildDeadline = Date.now() + rebuildDeadlineMs;
  let rebuildStatus = await getRebuildStatus(ids.remoteInstanceId);
  while (rebuildStatus.status !== 'complete' && Date.now() < rebuildDeadline) {
    if (rebuildStatus.status === 'failed') {
      const error = new Error('Reconstrução de identidades falhou');
      error.code = 'WA2_IDENTITY_REBUILD_FAILED';
      throw error;
    }
    await wait(2_000);
    rebuildStatus = await getRebuildStatus(ids.remoteInstanceId);
  }
  if (rebuildStatus.status !== 'complete') {
    const error = new Error('Reconstrução de identidades expirou');
    error.code = 'WA2_IDENTITY_REBUILD_TIMEOUT';
    throw error;
  }
}
