import crypto from 'node:crypto';
import {
  getWa2InstanceReplacementRun,
  updateWa2InstanceReplacementRunStatus,
  executeWa2InstanceReplacementItem,
  getWa2InstanceLocalById,
  listWa2InstancesLocal,
  closePool,
} from '../src/db.js';
import {
  detectWa2InstanceReplacement,
  maskReplacementPhone,
  normalizeCanonicalWhatsAppPhone,
} from '../src/wa2-instance-replacement.js';
import { collectWa2InstanceReplacementDryRun } from '../src/wa2-instance-replacement-runner.js';
import { wa2InstanceReplacementConfig } from '../src/wa2-instance-replacement-config.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRY_RUN_MAX_AGE_MS = 15 * 60 * 1000;

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function blocked(reason) {
  return { status: 'BLOCKED', writes: 0, reason };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function confirmationMatches(value, canonicalPhone) {
  const supplied = String(value || '').trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(supplied)) return false;
  return safeEqual(supplied.slice('sha256:'.length), sha256(canonicalPhone));
}

function maskId(value) {
  const text = String(value || '');
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text || 'AUSENTE';
}


function printDryRun(report) {
  const labels = report.labels;
  const counts = report.counts;
  const byResult = (result) => counts[result] || 0;
  console.log('RECUPERAÇÃO DE INSTÂNCIA — DRY-RUN');
  console.log('');
  console.log(`Conta lógica: ${report.detection.classification === 'SAME_ACCOUNT_REPLACEMENT' ? 'candidata' : 'não confirmada'}`);
  console.log(`Número autenticado confere: ${report.detection.classification === 'SAME_ACCOUNT_REPLACEMENT' ? 'SIM' : 'NÃO'}`);
  console.log(`PN normalizado confere: ${report.detection.oldIdentity?.normalizedPnJid ? 'SIM' : 'NÃO'}`);
  console.log(`Instância antiga: ${maskId(report.context.oldInstance.remote_instance_id)}`);
  console.log(`Instância nova: ${maskId(report.context.newInstance.remote_instance_id)}`);
  console.log(`Classificação: ${report.classification}`);
  console.log('');
  console.log('Etiquetas:');
  console.log(`Exact matches: ${labels.exactMatches.length}`);
  console.log(`Não encontradas: ${labels.notFound.length}`);
  console.log(`Ambíguas: ${labels.ambiguous.length}`);
  console.log(`Já alinhadas: ${labels.alreadyAligned.length}`);
  console.log('');
  console.log('Vínculos:');
  console.log(`Total antigo: ${report.totalLinks}`);
  console.log(`Exact single match: ${byResult('EXACT_SINGLE_MATCH')}`);
  console.log(`Já alinhados: ${byResult('ALREADY_ALIGNED')}`);
  console.log(`Sem correspondência: ${byResult('NO_MATCH')}`);
  console.log(`Múltiplos: ${byResult('MULTIPLE_MATCHES')}`);
  console.log(`Conflito de identidade: ${byResult('IDENTITY_CONFLICT')}`);
  console.log(`Telefone inválido: ${byResult('INVALID_PHONE')}`);
  console.log(`LID sem PN: ${byResult('LID_WITHOUT_PN')}`);
  console.log(`Não individuais: ${byResult('NON_INDIVIDUAL_CHAT')}`);
  console.log('');
  console.log('Identidades:');
  console.log(`Reutilizáveis: ${byResult('EXACT_SINGLE_MATCH')}`);
  console.log(`Conflitantes: ${byResult('IDENTITY_CONFLICT') + byResult('PHONE_CONFLICT')}`);
  console.log(`Pendentes: ${byResult('NO_MATCH') + byResult('MULTIPLE_MATCHES') + byResult('LID_WITHOUT_PN')}`);
  console.log('');
  console.log('Previsão:');
  console.log(`Vínculos antigos a encerrar: ${report.writes.oldLinksToUnlink}`);
  console.log(`Novos vínculos a criar: ${report.writes.newLinksToCreate}`);
  console.log(`Bindings a criar: ${report.writes.bindingsToCreate}`);
  console.log('Stages alterados: 0');
  console.log('MQLs criados: 0');
  console.log('Jobs CONVERSION: 0');
  console.log('Graph POST: 0');
  console.log('Writes realizados: 0');
  console.log(`Telefone autenticado: ${maskReplacementPhone(report.newStatus.phone)}`);
  const canonical = normalizeCanonicalWhatsAppPhone(report.newStatus.phone, { confirmedMobile: true });
  console.log(`Confirmação para execução: ${canonical ? `sha256:${sha256(canonical)}` : 'indisponível'}`);
}

async function executeRun({ runId, oldInstanceId, newInstanceId, confirmation }) {
  const config = wa2InstanceReplacementConfig();
  if (!config.enabled) return blocked('FEATURE_DISABLED');
  if (!config.executionEnabled) return blocked('EXECUTION_FEATURE_DISABLED');
  if (!UUID_PATTERN.test(runId) || !UUID_PATTERN.test(oldInstanceId) || !UUID_PATTERN.test(newInstanceId)) {
    return blocked('REQUIRED_UUID_ARGUMENT_MISSING_OR_INVALID');
  }
  if (!confirmation) return blocked('INSTANCE_CONFIRMATION_REQUIRED');
  const run = await getWa2InstanceReplacementRun(runId);
  if (!run) return blocked('RUN_NOT_FOUND');
  if (!['DRY_RUN_COMPLETED', 'WAITING_AUTHORIZATION'].includes(run.status)) return blocked('RUN_NOT_AUTHORIZED');
  if (run.old_instance_id !== oldInstanceId || run.new_instance_id !== newInstanceId) return blocked('RUN_INSTANCE_MISMATCH');
  if (!run.dry_run_at || Date.now() - new Date(run.dry_run_at).getTime() > DRY_RUN_MAX_AGE_MS) return blocked('DRY_RUN_EXPIRED');
  if (!run.summary || run.summary.classification !== 'SAME_ACCOUNT_REPLACEMENT') return blocked('DRY_RUN_NOT_VALID');
  if (run.items.length > 20) return blocked('RUN_BATCH_LIMIT_EXCEEDED');
  const [oldInstance, newInstance] = await Promise.all([
    getWa2InstanceLocalById(oldInstanceId),
    getWa2InstanceLocalById(newInstanceId),
  ]);
  if (!oldInstance || !newInstance || !newInstance.enabled) return blocked('LOCAL_INSTANCE_NOT_READY');
  let oldStatus;
  let newStatus;
  try {
    const { getWa2InstanceStatus } = await import('../src/wa2.js');
    [oldStatus, newStatus] = await Promise.all([
      getWa2InstanceStatus(oldInstance.remote_instance_id),
      getWa2InstanceStatus(newInstance.remote_instance_id),
    ]);
  } catch {
    return blocked('WA2_STATUS_UNAVAILABLE');
  }
  const activeSamePhone = (await listWa2InstancesLocal()).filter((instance) => (
    instance.enabled &&
    (instance.id === newInstance.id || normalizeCanonicalWhatsAppPhone(instance.phone, { confirmedMobile: true }) ===
      normalizeCanonicalWhatsAppPhone(newStatus?.phone, { confirmedMobile: true }))
  ));
  if (activeSamePhone.length !== 1) return blocked('ACTIVE_INSTANCE_COUNT_NOT_EXACTLY_ONE');
  const detection = detectWa2InstanceReplacement({
    tenantId: newInstance.tenant_id,
    oldInstance,
    newInstance,
    oldStatus,
    newStatus,
    activeInstanceCount: activeSamePhone.length,
  });
  if (detection.classification !== 'SAME_ACCOUNT_REPLACEMENT') return blocked(detection.reasonCode || 'REPLACEMENT_NOT_VALID');
  const canonicalPhone = detection.newIdentity?.canonicalPhone;
  if (!canonicalPhone || !confirmationMatches(confirmation, canonicalPhone)) return blocked('INSTANCE_CONFIRMATION_MISMATCH');
  await updateWa2InstanceReplacementRunStatus(runId, 'EXECUTING', { authorizedAt: new Date() });
  let completed = 0;
  let blockedItems = 0;
  try {
    for (const item of run.items) {
      if (item.result !== 'EXACT_SINGLE_MATCH') {
        blockedItems += 1;
        continue;
      }
      const resolved = item.writes?.resolved;
      if (!resolved) throw new Error('RUN_ITEM_EVIDENCE_MISSING');
      await executeWa2InstanceReplacementItem({
        runId,
        leadId: item.lead_id,
        oldLinkId: item.old_link_id,
        newInstanceId: run.new_instance_id,
        canonicalPhone: resolved.phoneNormalized,
        resolved: {
          contact: {
            id: resolved.contactId,
            jid: resolved.contactJid,
            phoneNormalized: resolved.phoneNormalized,
          },
          chat: { id: resolved.chatId, jid: resolved.chatJid },
        },
      });
      completed += 1;
    }
    await updateWa2InstanceReplacementRunStatus(
      runId,
      blockedItems ? 'PARTIAL' : 'COMPLETED',
      { executedAt: new Date() },
    );
    console.log(`RECUPERAÇÃO EXECUTADA: ${blockedItems ? 'PARTIAL' : 'COMPLETED'}; itens=${completed}; bloqueados=${blockedItems}`);
  } catch (error) {
    await updateWa2InstanceReplacementRunStatus(runId, 'FAILED', { errorCode: 'WA2_REPLACEMENT_EXECUTION_FAILED' });
    throw error;
  }
}

async function main() {
  try {
    if (hasFlag('dry-run')) {
      if (!wa2InstanceReplacementConfig().enabled) {
        console.log('status=BLOCKED; writes=0; reason=FEATURE_DISABLED');
        return;
      }
      const oldInstanceId = argument('old-instance');
      const newInstanceId = argument('new-instance');
      if (!/^[0-9a-f-]{36}$/i.test(oldInstanceId) || !/^[0-9a-f-]{36}$/i.test(newInstanceId)) {
        throw new Error('Uso: --dry-run --old-instance=<UUID> --new-instance=<UUID>');
      }
      const report = await collectWa2InstanceReplacementDryRun(oldInstanceId, newInstanceId);
      printDryRun(report);
      return;
    }
    if (hasFlag('execute')) {
      const result = await executeRun({
        runId: argument('run-id'),
        oldInstanceId: argument('old-instance'),
        newInstanceId: argument('new-instance'),
        confirmation: argument('confirm-instance-replacement'),
      });
      if (result?.status === 'BLOCKED') {
        console.log(`status=BLOCKED; writes=0; reason=${result.reason}`);
      }
      return;
    }
    throw new Error('Uso: node scripts/wa2-instance-replacement.mjs --dry-run --old-instance=<UUID> --new-instance=<UUID>');
  } catch (error) {
    fail(error?.message || 'Falha no dry-run de substituição.');
  } finally {
    await closePool();
  }
}

main();
