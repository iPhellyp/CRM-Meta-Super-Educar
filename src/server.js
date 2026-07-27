import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import {
  Wa2DataError,
  createMetaHistoricalImport,
  createWa2Reconciliation,
  createWa2ContactLink,
  decideWa2StageConfirmation,
  disableWa2Instance,
  enableWa2Instance,
  enqueueLeadgenJobs,
  closePool,
  getActiveWa2ContactLinkForLead,
  getDashboardCounts,
  getLeadById,
  getWa2ContactLinkById,
  getWa2InstanceLocalById,
  getWa2LabelBindingById,
  getWa2LabelJobCounts,
  getWa2LabelSyncStatusForLead,
  healthcheck,
  listLeads,
  listHistoricalOperations,
  listWa2InstancesLocal,
  listWa2LabelBindings,
  listWa2LabelJobs,
  listRecentJobs,
  listRecentMetaEvents,
  migrate,
  moveLeadStage,
  operationStartAt,
  replaceWa2ContactLink,
  retryFailedJob,
  retryFailedWa2LabelJob,
  retryWa2ReconciliationFailures,
  setMetaHistoricalImportStatus,
  setDefaultWa2Instance,
  setWa2LabelBindingEnabled,
  unlinkWa2ContactLink,
  upsertLead,
  upsertVerifiedWa2Instance,
  upsertWa2LabelBinding,
  validateDatabaseConfig,
  verifyWa2ContactLink,
  verifyWa2LabelBinding,
} from './db.js';
import {
  clearSession,
  credentialsAreValid,
  issueCsrfToken,
  requireAuth,
  requireCsrf,
  setSession,
  validateAuthConfig,
} from './auth.js';
import {
  currentMetaMode,
  metaConfigStatus,
  validateMetaConfig,
  verifyMetaSignature,
} from './meta.js';
import {
  STAGE_LABELS,
  STAGES,
  canTransition,
  getStageEventName,
  isDirectStageTarget,
} from './funnel.js';
import {
  dashboardView,
  eventsView,
  historicalOperationsView,
  loginView,
  matriculationConfirmView,
  leadWa2View,
  wa2DashboardView,
  wa2InstanceView,
  wa2LinkConfirmView,
  wa2LabelBindingsView,
  wa2LabelJobsView,
  wa2QrView,
} from './views.js';
import {
  Wa2Error,
  connectWa2Instance,
  disconnectWa2Instance,
  getWa2ContactByPhone,
  getWa2Health,
  getWa2InstanceQr,
  getWa2InstanceStatus,
  listWa2Instances,
  listWa2Labels,
  syncWa2Instance,
  validateWa2InstanceId,
  wa2ConfigStatus,
} from './wa2.js';
import { normalizeWhatsAppPhone } from './phone.js';
import {
  createWa2ResolutionToken,
  wa2ResolutionTokenIsValid,
} from './wa2-link-token.js';
import { validateWa2ConfirmationState } from './wa2-link-rules.js';
import { isWa2LabelStage } from './wa2-label-sync.js';

const app = express();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
app.set('trust proxy', 1);
app.use(helmet());
app.use(compression());
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buffer) => { req.rawBody = buffer; },
}));
app.use(cookieParser());
app.use(express.static('public', { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

function validateServerConfig() {
  const errors = [];
  const configuredPort = Number(process.env.PORT || 3000);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
    errors.push('PORT');
  }
  if (!String(process.env.DEFAULT_TENANT_ID || '').trim()) errors.push('DEFAULT_TENANT_ID');
  if (!process.env.OPERATION_START_AT || Number.isNaN(new Date(process.env.OPERATION_START_AT).getTime())) {
    errors.push('OPERATION_START_AT em ISO 8601');
  }
  try {
    const appUrl = new URL(process.env.APP_URL);
    if (process.env.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
      errors.push('APP_URL com HTTPS');
    }
  } catch {
    errors.push('APP_URL');
  }
  if (errors.length) throw new Error(`Configuração do servidor inválida: ${errors.join(', ')}`);
}

function redirectWith(res, path, type, message) {
  const url = new URL(path, process.env.APP_URL || 'http://localhost:3000');
  url.searchParams.set(type, message);
  res.redirect(`${url.pathname}${url.search}`);
}

function textIsEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (attempt?.blockedUntil > now) {
    return res.status(429).send(loginView(
      'Muitas tentativas. Aguarde alguns minutos.',
      issueCsrfToken(req, res),
    ));
  }
  if (attempt && now - attempt.startedAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return next();
}

function recordFailedLogin(req) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt = !current || now - current.startedAt > LOGIN_WINDOW_MS
    ? { count: 0, startedAt: now, blockedUntil: 0 }
    : current;
  attempt.count += 1;
  if (attempt.count >= LOGIN_MAX_ATTEMPTS) attempt.blockedUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(key, attempt);
  if (loginAttempts.size > 10_000) {
    for (const [attemptKey, value] of loginAttempts) {
      if (value.blockedUntil <= now && now - value.startedAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(attemptKey);
      }
    }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await healthcheck();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/login', (req, res) => res.send(loginView('', issueCsrfToken(req, res))));
app.post('/login', loginRateLimit, requireCsrf, (req, res) => {
  const email = String(req.body.email || '');
  const password = String(req.body.password || '');
  if (!credentialsAreValid(email, password)) {
    recordFailedLogin(req);
    return res.status(401).send(loginView(
      'E-mail ou senha inválidos.',
      issueCsrfToken(req, res),
    ));
  }
  loginAttempts.delete(req.ip || 'unknown');
  setSession(res, email);
  res.redirect('/');
});

app.get('/webhooks/meta/leadgen', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (
    mode === 'subscribe' &&
    process.env.META_WEBHOOK_VERIFY_TOKEN &&
    textIsEqual(token, process.env.META_WEBHOOK_VERIFY_TOKEN) &&
    challenge != null
  ) {
    return res.status(200).send(String(challenge));
  }
  return res.status(403).json({ error: 'Falha na validação do webhook' });
});

app.post('/webhooks/meta/leadgen', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    return res.status(401).json({ error: 'Assinatura Meta inválida' });
  }
  try {
    const queued = await enqueueLeadgenJobs(req.body);
    console.log(JSON.stringify({ level: 'info', msg: 'Webhook leadgen registrado', queued }));
    return res.status(200).json({ received: true, queued });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'Falha ao registrar webhook leadgen',
      error: error?.name || 'Error',
    }));
    return res.status(503).json({ received: false });
  }
});

app.use(requireAuth);
app.use((req, res, next) => req.method === 'POST' ? requireCsrf(req, res, next) : next());

app.post('/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/login');
});

const metaHistoricalIdsSchema = z.object({
  pageId: z.string().regex(/^[0-9]{1,100}$/),
  formId: z.string().regex(/^[0-9]{1,100}$/),
});

app.get('/operations', async (req, res) => {
  try {
    const [operations, instances] = await Promise.all([
      listHistoricalOperations(),
      listWa2InstancesLocal(),
    ]);
    return res.send(historicalOperationsView({
      operations,
      instances,
      message: req.query.message || '',
      error: req.query.error || '',
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch {
    return redirectWith(res, '/', 'error', 'Não foi possível carregar as operações.');
  }
});

app.post('/operations/meta-imports', async (req, res) => {
  const parsed = metaHistoricalIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    return redirectWith(res, '/operations', 'error', 'Page ID ou Form ID inválido.');
  }
  await createMetaHistoricalImport({
    ...parsed.data,
    actor: req.user.sub,
  });
  return redirectWith(res, '/operations', 'message', 'Importação Meta enfileirada.');
});

app.post('/operations/meta-imports/:id/:action', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const action = String(req.params.action || '');
  if (!id.success || !['resume', 'cancel'].includes(action)) {
    return redirectWith(res, '/operations', 'error', 'Ação de importação inválida.');
  }
  const changed = await setMetaHistoricalImportStatus(id.data, action);
  return redirectWith(
    res,
    '/operations',
    changed ? 'message' : 'error',
    changed ? 'Importação atualizada.' : 'Importação não está no estado permitido.',
  );
});

app.post('/operations/reconciliations', async (req, res) => {
  const instanceId = z.string().uuid().safeParse(req.body.instanceId);
  if (!instanceId.success) {
    return redirectWith(res, '/operations', 'error', 'Instância inválida.');
  }
  try {
    await createWa2Reconciliation({
      instanceId: instanceId.data,
      actor: req.user.sub,
    });
    return redirectWith(res, '/operations', 'message', 'Reconciliação enfileirada.');
  } catch (error) {
    return redirectWith(res, '/operations', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/operations/reconciliations/:id/retry', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    return redirectWith(res, '/operations', 'error', 'Reconciliação inválida.');
  }
  const count = await retryWa2ReconciliationFailures(id.data);
  return redirectWith(
    res,
    '/operations',
    count ? 'message' : 'error',
    count ? `${count} item(ns) reenfileirado(s).` : 'Nenhuma falha disponível para retry.',
  );
});

app.post('/operations/confirmations/:id/:decision', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const decision = String(req.params.decision || '');
  if (!id.success || !['confirm', 'reject'].includes(decision)) {
    return redirectWith(res, '/operations', 'error', 'Confirmação inválida.');
  }
  try {
    const changed = await decideWa2StageConfirmation(
      id.data,
      decision,
      req.user.sub,
    );
    return redirectWith(
      res,
      '/operations',
      changed ? 'message' : 'error',
      changed ? 'Confirmação registrada.' : 'Pendência não encontrada.',
    );
  } catch {
    return redirectWith(res, '/operations', 'error', 'Transição de matrícula indisponível.');
  }
});

function noStore(res) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
  });
}

function wa2UnavailableMessage(error) {
  if (error instanceof Wa2Error && error.code === 'WA2_TIMEOUT') {
    return 'O WA2 não respondeu dentro do prazo.';
  }
  if (error instanceof Wa2Error && error.code === 'WA2_DISABLED') {
    return 'A integração WA2 está desativada.';
  }
  if (error instanceof Wa2Error && error.code === 'WA2_CONFIG_INVALID') {
    return 'A configuração WA2 está inválida.';
  }
  return 'Não foi possível concluir a operação no WA2.';
}

app.get('/wa2', async (req, res) => {
  const configStatus = wa2ConfigStatus();
  let health = null;
  let instances = [];
  let unavailable = false;
  const localInstances = await listWa2InstancesLocal();
  if (configStatus.state === 'configured') {
    const [healthResult, instancesResult] = await Promise.allSettled([
      getWa2Health(),
      listWa2Instances(),
    ]);
    if (healthResult.status === 'fulfilled') health = healthResult.value;
    if (instancesResult.status === 'fulfilled') instances = instancesResult.value;
    unavailable = healthResult.status === 'rejected' || instancesResult.status === 'rejected';
  }
  res.send(wa2DashboardView({
    configStatus,
    health,
    instances,
    localInstances,
    unavailable,
    message: req.query.message || '',
    error: req.query.error || '',
    csrfToken: issueCsrfToken(req, res),
  }));
});

app.post('/wa2/instances/import', async (req, res) => {
  try {
    const remoteInstanceId = validateWa2InstanceId(req.body.remoteInstanceId);
    const remoteInstances = await listWa2Instances();
    const remoteInstance = remoteInstances.find((item) => item.id === remoteInstanceId);
    if (!remoteInstance) {
      return redirectWith(res, '/wa2', 'error', 'Instância não foi confirmada no WA2.');
    }
    await upsertVerifiedWa2Instance(remoteInstance, req.user.sub);
    return redirectWith(res, '/wa2', 'message', 'Instância WA2 validada e salva no CRM.');
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/local-instances/:id/default', async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    await setDefaultWa2Instance(id);
    return redirectWith(res, '/wa2', 'message', 'Instância definida como padrão.');
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/local-instances/:id/enable', async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const instance = await enableWa2Instance(id);
    if (!instance) return redirectWith(res, '/wa2', 'error', 'Instância local não encontrada.');
    return redirectWith(res, '/wa2', 'message', 'Instância local habilitada.');
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/local-instances/:id/disable', async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const clearDefault = req.body.confirmation === 'DISABLE_DEFAULT_WA2_INSTANCE';
    const instance = await disableWa2Instance(id, { clearDefault });
    if (!instance) return redirectWith(res, '/wa2', 'error', 'Instância local não encontrada.');
    return redirectWith(res, '/wa2', 'message', 'Instância local desabilitada.');
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.get('/wa2/labels', async (req, res) => {
  const requestedInstanceId = String(req.query.instanceId || '');
  const parsedInstanceId = requestedInstanceId
    ? z.string().uuid().safeParse(requestedInstanceId)
    : null;
  if (parsedInstanceId && !parsedInstanceId.success) {
    return redirectWith(res, '/wa2/labels', 'error', 'Instância local inválida.');
  }
  const instanceId = parsedInstanceId?.data || null;
  try {
    const [instances, bindings] = await Promise.all([
      listWa2InstancesLocal(),
      listWa2LabelBindings(instanceId),
    ]);
    const selectedInstance = instanceId
      ? instances.find((instance) => instance.id === instanceId) || null
      : null;
    let labels = [];
    let remoteError = '';
    if (instanceId && !selectedInstance) {
      return redirectWith(res, '/wa2/labels', 'error', 'Instância local não encontrada.');
    }
    if (selectedInstance) {
      try {
        labels = await listWa2Labels(selectedInstance.remote_instance_id);
      } catch (error) {
        remoteError = wa2UnavailableMessage(error);
      }
    }
    return res.send(wa2LabelBindingsView({
      instances,
      selectedInstance,
      labels,
      bindings,
      message: req.query.message || '',
      error: req.query.error || remoteError,
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/labels/bindings', async (req, res) => {
  const parsedInstanceId = z.string().uuid().safeParse(req.body.instanceId);
  const stage = String(req.body.stage || '');
  const remoteLabelId = String(req.body.remoteLabelId || '');
  if (!parsedInstanceId.success || !isWa2LabelStage(stage) || !remoteLabelId) {
    return redirectWith(res, '/wa2/labels', 'error', 'Binding de etiqueta inválido.');
  }
  const path = `/wa2/labels?instanceId=${encodeURIComponent(parsedInstanceId.data)}`;
  try {
    const instance = await getWa2InstanceLocalById(parsedInstanceId.data);
    if (!instance?.enabled) {
      throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
    }
    const labels = await listWa2Labels(instance.remote_instance_id);
    const remoteLabel = labels.find((label) => label.id === remoteLabelId);
    if (!remoteLabel) {
      return redirectWith(res, path, 'error', 'Etiqueta não foi confirmada no WA2.');
    }
    await upsertWa2LabelBinding({
      instanceId: instance.id,
      stage,
      remoteLabelId: remoteLabel.id,
      remoteLabelName: remoteLabel.name,
    });
    return redirectWith(res, path, 'message', 'Binding validado e salvo.');
  } catch (error) {
    return redirectWith(res, path, 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/label-bindings/:id/:action', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const action = String(req.params.action || '');
  if (!parsedId.success || !['enable', 'disable', 'verify'].includes(action)) {
    return redirectWith(res, '/wa2/labels', 'error', 'Ação de binding inválida.');
  }
  try {
    const binding = await getWa2LabelBindingById(parsedId.data);
    if (!binding) {
      return redirectWith(res, '/wa2/labels', 'error', 'Binding não encontrado.');
    }
    const path = `/wa2/labels?instanceId=${encodeURIComponent(binding.wa2_instance_id)}`;
    if (action === 'disable') {
      await setWa2LabelBindingEnabled(binding.id, false);
      return redirectWith(res, path, 'message', 'Binding desabilitado.');
    }
    if (!binding.instance_enabled) {
      throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
    }
    const labels = await listWa2Labels(binding.remote_instance_id);
    const remoteLabel = labels.find((label) => label.id === binding.remote_label_id);
    if (!remoteLabel) {
      return redirectWith(res, path, 'error', 'Etiqueta não existe mais no WA2.');
    }
    const verified = await verifyWa2LabelBinding(binding.id, remoteLabel);
    if (verified.length === 0) {
      throw new Wa2DataError(
        'O binding mudou durante a verificação',
        'WA2_LABEL_BINDING_CHANGED',
      );
    }
    if (action === 'enable') await setWa2LabelBindingEnabled(binding.id, true);
    return redirectWith(
      res,
      path,
      'message',
      action === 'enable' ? 'Binding verificado e habilitado.' : 'Binding verificado.',
    );
  } catch (error) {
    return redirectWith(res, '/wa2/labels', 'error', wa2LinkErrorMessage(error));
  }
});

app.get('/wa2/label-jobs', async (req, res) => {
  try {
    const [jobs, counts] = await Promise.all([
      listWa2LabelJobs(),
      getWa2LabelJobCounts(),
    ]);
    return res.send(wa2LabelJobsView({
      jobs,
      counts,
      message: req.query.message || '',
      error: req.query.error || '',
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/wa2/label-jobs/:id/retry', async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const retried = await retryFailedWa2LabelJob(id);
    if (!retried) {
      return redirectWith(
        res,
        '/wa2/label-jobs',
        'error',
        'Somente jobs FAILED com tentativas disponíveis podem ser reenviados.',
      );
    }
    return redirectWith(
      res,
      '/wa2/label-jobs',
      'message',
      'Job WA2 reenfileirado sem apagar o histórico de tentativas.',
    );
  } catch {
    return redirectWith(res, '/wa2/label-jobs', 'error', 'Não foi possível reenviar o job.');
  }
});

app.get('/wa2/instances/:id', async (req, res) => {
  try {
    const instanceId = validateWa2InstanceId(req.params.id);
    const status = await getWa2InstanceStatus(instanceId);
    return res.send(wa2InstanceView({
      instanceId,
      status,
      message: req.query.message || '',
      error: req.query.error || '',
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return redirectWith(res, '/wa2', 'error', wa2UnavailableMessage(error));
  }
});

app.get('/wa2/instances/:id/qr', async (req, res) => {
  noStore(res);
  try {
    const instanceId = validateWa2InstanceId(req.params.id);
    const status = await getWa2InstanceStatus(instanceId);
    return res.send(wa2QrView({
      instanceId,
      status,
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return res.status(503).send(wa2QrView({
      instanceId: '',
      status: {},
      error: wa2UnavailableMessage(error),
      csrfToken: issueCsrfToken(req, res),
    }));
  }
});

app.get('/wa2/instances/:id/qr/image', async (req, res) => {
  noStore(res);
  try {
    const instanceId = validateWa2InstanceId(req.params.id);
    const qr = await getWa2InstanceQr(instanceId);
    return res.type(qr.contentType).send(qr.bytes);
  } catch (error) {
    const status = error instanceof Wa2Error && error.code === 'WA2_QR_EXPIRED' ? 410 : 503;
    return res.status(status).type('text/plain').send(
      status === 410 ? 'QR expirado.' : 'QR indisponível.',
    );
  }
});

app.post('/wa2/instances/:id/connect', async (req, res) => {
  let instanceId;
  try {
    instanceId = validateWa2InstanceId(req.params.id);
    const mode = z.enum(['auto', 'resume', 'new_qr']).parse(req.body.mode);
    await connectWa2Instance(instanceId, mode);
    return redirectWith(
      res,
      `/wa2/instances/${encodeURIComponent(instanceId)}`,
      'message',
      'Solicitação de conexão enviada ao WA2.',
    );
  } catch (error) {
    const path = instanceId
      ? `/wa2/instances/${encodeURIComponent(instanceId)}`
      : '/wa2';
    return redirectWith(res, path, 'error', wa2UnavailableMessage(error));
  }
});

app.post('/wa2/instances/:id/sync', async (req, res) => {
  let instanceId;
  try {
    instanceId = validateWa2InstanceId(req.params.id);
    const scope = z.enum(['quick', 'catalog', 'history']).parse(req.body.scope);
    await syncWa2Instance(instanceId, scope);
    return redirectWith(
      res,
      `/wa2/instances/${encodeURIComponent(instanceId)}`,
      'message',
      'Solicitação de sincronização enviada ao WA2.',
    );
  } catch (error) {
    const path = instanceId
      ? `/wa2/instances/${encodeURIComponent(instanceId)}`
      : '/wa2';
    return redirectWith(res, path, 'error', wa2UnavailableMessage(error));
  }
});

app.post('/wa2/instances/:id/disconnect', async (req, res) => {
  let instanceId;
  try {
    instanceId = validateWa2InstanceId(req.params.id);
    await disconnectWa2Instance(instanceId);
    return redirectWith(
      res,
      `/wa2/instances/${encodeURIComponent(instanceId)}`,
      'message',
      'Solicitação de desconexão enviada ao WA2 com preservação da sessão.',
    );
  } catch (error) {
    const path = instanceId
      ? `/wa2/instances/${encodeURIComponent(instanceId)}`
      : '/wa2';
    return redirectWith(res, path, 'error', wa2UnavailableMessage(error));
  }
});

function wa2LinkErrorMessage(error) {
  if (error instanceof Wa2DataError) {
    const messages = {
      WA2_INSTANCE_TENANT_CONFLICT: 'A instância já pertence a outro tenant.',
      WA2_INSTANCE_NOT_FOUND: 'Instância local não encontrada.',
      WA2_INSTANCE_DISABLED: 'A instância local está desabilitada.',
      WA2_DEFAULT_INSTANCE_CONFLICT:
        'Confirme explicitamente a remoção da condição padrão antes de desabilitar.',
      WA2_LEAD_NOT_FOUND: 'Lead não encontrado.',
      WA2_LEAD_PHONE_MISSING: 'O lead não possui telefone.',
      WA2_LEAD_PHONE_INVALID: 'O telefone do lead é inválido.',
      WA2_LEAD_PHONE_CHANGED: 'O telefone do lead mudou. Resolva o contato novamente.',
      WA2_LINK_CONFLICT: 'Já existe um vínculo conflitante para este lead ou chat.',
      WA2_LINK_NOT_FOUND: 'Vínculo ativo não encontrado.',
      WA2_LINK_CHANGED: 'O contato ou chat remoto mudou. Confirme uma substituição.',
      WA2_RESOLUTION_CHANGED:
        'A confirmação expirou ou o contato/chat mudou. Resolva novamente.',
      WA2_CONTACT_WITHOUT_CHAT: 'O contato foi encontrado, mas ainda não possui chat.',
    };
    return messages[error.code] || 'Não foi possível alterar o vínculo WA2.';
  }
  if (error instanceof Wa2Error) {
    if (error.remoteCode === 'CONTACT_NOT_FOUND') return 'Contato não encontrado no WA2.';
    if (error.remoteCode === 'INSTANCE_NOT_FOUND') return 'Instância não encontrada no WA2.';
    if (error.remoteCode === 'CONTACT_AMBIGUOUS' || error.status === 409) {
      return 'O WA2 encontrou um resultado ambíguo.';
    }
    if (error.status === 404) return 'Recurso não encontrado no WA2.';
    const messages = {
      WA2_PHONE_INVALID: 'O telefone do lead é inválido.',
      WA2_PHONE_MISMATCH: 'O telefone retornado pelo WA2 é diferente do lead.',
      WA2_UNSUPPORTED_JID: 'O contato não possui um JID individual por telefone.',
      WA2_LID_UNRESOLVED: 'O contato possui LID sem telefone individual resolvido.',
      WA2_GROUP_UNSUPPORTED: 'Grupos não podem ser vinculados a leads.',
      WA2_BROADCAST_UNSUPPORTED: 'Broadcasts, status e canais não podem ser vinculados.',
      WA2_JID_MISMATCH: 'O contato e o chat representam JIDs diferentes.',
      WA2_CONTACT_INVALID: 'A resposta do contato WA2 é incompatível.',
      WA2_CHAT_INVALID: 'A resposta do chat WA2 é incompatível.',
      WA2_TIMEOUT: 'O WA2 não respondeu dentro do prazo.',
    };
    return messages[error.code] || wa2UnavailableMessage(error);
  }
  return 'Não foi possível concluir a operação WA2.';
}

async function resolveLeadWa2Contact(lead, instance) {
  if (!instance?.enabled) {
    throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
  }
  const phoneNormalized = normalizeWhatsAppPhone(lead.phone);
  if (!lead.phone) {
    throw new Wa2DataError('Lead sem telefone', 'WA2_LEAD_PHONE_MISSING');
  }
  if (!phoneNormalized) {
    throw new Wa2DataError('Telefone do lead inválido', 'WA2_LEAD_PHONE_INVALID');
  }
  if (phoneNormalized !== lead.phone_normalized) {
    throw new Wa2DataError(
      'Telefone do lead inválido ou desatualizado',
      'WA2_LEAD_PHONE_CHANGED',
    );
  }
  const resolved = await getWa2ContactByPhone(
    instance.remote_instance_id,
    phoneNormalized,
  );
  if (!resolved.chat) {
    throw new Wa2DataError('Contato sem chat disponível', 'WA2_CONTACT_WITHOUT_CHAT');
  }
  return { resolved, phoneNormalized };
}

app.get('/leads/:id/wa2', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  try {
    const [lead, instances, links] = await Promise.all([
      getLeadById(parsedId.data),
      listWa2InstancesLocal({ enabledOnly: true }),
      getActiveWa2ContactLinkForLead(parsedId.data),
    ]);
    if (!lead) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    const labelSync = await getWa2LabelSyncStatusForLead(lead.id, lead.stage);
    return res.send(leadWa2View({
      lead,
      instances,
      links,
      labelSync,
      message: req.query.message || '',
      error: req.query.error || '',
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return redirectWith(res, '/', 'error', wa2LinkErrorMessage(error));
  }
});

app.post('/leads/:id/wa2/resolve', async (req, res) => {
  const parsedLeadId = z.string().uuid().safeParse(req.params.id);
  const parsedInstanceId = z.string().uuid().safeParse(req.body.instanceId);
  if (!parsedLeadId.success || !parsedInstanceId.success) {
    return redirectWith(res, '/', 'error', 'Lead ou instância inválida.');
  }
  try {
    const [lead, instance, currentLink] = await Promise.all([
      getLeadById(parsedLeadId.data),
      getWa2InstanceLocalById(parsedInstanceId.data),
      getActiveWa2ContactLinkForLead(parsedLeadId.data, parsedInstanceId.data),
    ]);
    if (!lead) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    const { resolved, phoneNormalized } = await resolveLeadWa2Contact(lead, instance);
    const expectedAction = currentLink ? 'REPLACE' : 'CREATE';
    const expectedLinkId = currentLink?.id ?? null;
    return res.send(wa2LinkConfirmView({
      lead,
      instance,
      resolved,
      phoneNormalized,
      currentLink,
      expectedAction,
      expectedLinkId,
      resolutionToken: createWa2ResolutionToken({
        leadId: lead.id,
        instanceId: instance.id,
        phoneNormalized,
        resolved,
        expectedAction,
        expectedLinkId,
      }, { secret: process.env.SESSION_SECRET }),
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch (error) {
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'error',
      wa2LinkErrorMessage(error),
    );
  }
});

app.post('/leads/:id/wa2/confirm', async (req, res) => {
  const parsedLeadId = z.string().uuid().safeParse(req.params.id);
  const parsedInstanceId = z.string().uuid().safeParse(req.body.instanceId);
  const expectedAction = req.body.expectedAction;
  const parsedExpectedLinkId = z.string().uuid().safeParse(req.body.expectedLinkId);
  const expectedLinkId = expectedAction === 'CREATE' ? null : parsedExpectedLinkId.data;
  const expectedLinkIdIsValid = expectedAction === 'CREATE'
    ? req.body.expectedLinkId == null || req.body.expectedLinkId === ''
    : expectedAction === 'REPLACE' && parsedExpectedLinkId.success;
  if (
    !parsedLeadId.success ||
    !parsedInstanceId.success ||
    req.body.confirmation !== 'CONFIRM_WA2_LINK' ||
    !['CREATE', 'REPLACE'].includes(expectedAction) ||
    !expectedLinkIdIsValid ||
    typeof req.body.resolutionToken !== 'string'
  ) {
    return redirectWith(res, '/', 'error', 'Confirmação de vínculo inválida.');
  }
  try {
    const [lead, instance, currentLink] = await Promise.all([
      getLeadById(parsedLeadId.data),
      getWa2InstanceLocalById(parsedInstanceId.data),
      getActiveWa2ContactLinkForLead(parsedLeadId.data, parsedInstanceId.data),
    ]);
    if (!lead) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    const { resolved, phoneNormalized } = await resolveLeadWa2Contact(lead, instance);
    if (!wa2ResolutionTokenIsValid(req.body.resolutionToken, {
      leadId: lead.id,
      instanceId: instance.id,
      phoneNormalized,
      resolved,
      expectedAction,
      expectedLinkId,
    }, { secret: process.env.SESSION_SECRET })) {
      throw new Wa2DataError(
        'A resolução WA2 expirou ou o contato/chat mudou',
        'WA2_RESOLUTION_CHANGED',
      );
    }
    validateWa2ConfirmationState({
      expectedAction,
      expectedLinkId,
      currentLink,
    });
    if (expectedAction === 'REPLACE') {
      await replaceWa2ContactLink({
        leadId: lead.id,
        instanceId: instance.id,
        expectedLinkId,
        expectedPhoneNormalized: phoneNormalized,
        resolved,
        actor: req.user.sub,
      });
    } else {
      await createWa2ContactLink({
        leadId: lead.id,
        instanceId: instance.id,
        expectedPhoneNormalized: phoneNormalized,
        resolved,
        actor: req.user.sub,
      });
    }
    return redirectWith(
      res,
      `/leads/${lead.id}/wa2`,
      'message',
      expectedAction === 'REPLACE'
        ? 'Vínculo WA2 confirmado ou substituído.'
        : 'Vínculo WA2 criado.',
    );
  } catch (error) {
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'error',
      wa2LinkErrorMessage(error),
    );
  }
});

app.post('/leads/:id/wa2/verify', async (req, res) => {
  const parsedLeadId = z.string().uuid().safeParse(req.params.id);
  const parsedLinkId = z.string().uuid().safeParse(req.body.linkId);
  if (!parsedLeadId.success || !parsedLinkId.success) {
    return redirectWith(res, '/', 'error', 'Vínculo inválido.');
  }
  try {
    const [link, lead] = await Promise.all([
      getWa2ContactLinkById(parsedLinkId.data),
      getLeadById(parsedLeadId.data),
    ]);
    if (!link || link.lead_id !== parsedLeadId.data || link.unlinked_at) {
      return redirectWith(res, '/', 'error', 'Vínculo ativo não encontrado.');
    }
    if (!lead || lead.phone_normalized !== link.phone_normalized) {
      throw new Wa2DataError(
        'O telefone do lead mudou durante a verificação',
        'WA2_LEAD_PHONE_CHANGED',
      );
    }
    if (!link.instance_enabled) {
      throw new Wa2DataError('Instância local está desabilitada', 'WA2_INSTANCE_DISABLED');
    }
    const resolved = await getWa2ContactByPhone(
      link.remote_instance_id,
      link.phone_normalized,
    );
    if (!resolved.chat) {
      throw new Wa2DataError('Contato sem chat disponível', 'WA2_CONTACT_WITHOUT_CHAT');
    }
    await verifyWa2ContactLink({ linkId: link.id, resolved });
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'message',
      'Vínculo WA2 verificado.',
    );
  } catch (error) {
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'error',
      wa2LinkErrorMessage(error),
    );
  }
});

app.post('/leads/:id/wa2/unlink', async (req, res) => {
  const parsedLeadId = z.string().uuid().safeParse(req.params.id);
  const parsedLinkId = z.string().uuid().safeParse(req.body.linkId);
  if (
    !parsedLeadId.success ||
    !parsedLinkId.success ||
    req.body.confirmation !== 'UNLINK_WA2'
  ) {
    return redirectWith(res, '/', 'error', 'Confirmação de desvínculo inválida.');
  }
  try {
    const link = await getWa2ContactLinkById(parsedLinkId.data);
    if (!link || link.lead_id !== parsedLeadId.data) {
      return redirectWith(res, '/', 'error', 'Vínculo não encontrado.');
    }
    const unlinked = await unlinkWa2ContactLink({
      linkId: link.id,
      actor: req.user.sub,
    });
    if (!unlinked) {
      return redirectWith(res, '/', 'error', 'Vínculo já estava desfeito.');
    }
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'message',
      'Vínculo WA2 desfeito sem apagar o histórico.',
    );
  } catch (error) {
    return redirectWith(
      res,
      `/leads/${parsedLeadId.data}/wa2`,
      'error',
      wa2LinkErrorMessage(error),
    );
  }
});

app.get('/', async (req, res) => {
  const [leads, counts] = await Promise.all([listLeads(), getDashboardCounts()]);
  res.send(dashboardView({
    leads,
    counts,
    metaStatus: metaConfigStatus(),
    message: req.query.message || '',
    error: req.query.error || '',
    operationStartAt: operationStartAt(),
    csrfToken: issueCsrfToken(req, res),
  }));
});

const leadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email().or(z.literal('')).optional(),
  course: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
});

app.post('/leads', async (req, res) => {
  try {
    const data = leadSchema.parse(req.body);
    await upsertLead({
      ...data,
      source: 'MANUAL',
    });
    redirectWith(res, '/', 'message', 'Lead adicionado.');
  } catch {
    redirectWith(res, '/', 'error', 'Não foi possível adicionar o lead. Revise os campos.');
  }
});

function metaResultSuffix(eventName, result) {
  if (!eventName) return '';
  if (!result.attributed) return ' Lead sem atribuição Meta; nenhum evento foi criado.';
  if (result.event.status === 'SENT') return ' O evento Meta já havia sido enviado.';
  return result.jobCreated ? ' Evento Meta enfileirado.' : ' Evento Meta já está na fila.';
}

function wa2LabelResultSuffix(result) {
  const sync = result.wa2LabelSync;
  if (!sync) return '';
  if (sync.scheduled > 0) {
    return ` ${sync.scheduled} sincronização(ões) de etiqueta WA2 agendada(s).`;
  }
  const messages = {
    NO_ACTIVE_LINK: ' Etiqueta WA2 não agendada: lead sem vínculo ativo.',
    NO_ENABLED_BINDING: ' Etiqueta WA2 não agendada: binding ausente ou desabilitado.',
    LABEL_UNCHANGED: ' Etiqueta WA2 já representa a mesma etapa; nenhuma mutação agendada.',
    STAGE_NOT_MAPPED: ' Etapa sem sincronização automática de etiqueta WA2.',
    DUPLICATE: ' Sincronização de etiqueta WA2 já registrada.',
  };
  return messages[sync.reason] || '';
}

app.post('/leads/:id/stage', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  const stage = String(req.body.stage || '');
  if (!isDirectStageTarget(stage)) {
    return redirectWith(res, '/', 'error', 'Etapa inválida.');
  }
  try {
    const eventName = getStageEventName(stage);
    const result = await moveLeadStage(parsedId.data, stage, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      mode: currentMetaMode(),
    });
    if (!result) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    if (result.invalidTransition) {
      return redirectWith(res, '/', 'error', 'Transição de etapa não permitida.');
    }
    const suffix = metaResultSuffix(eventName, result);
    const wa2Suffix = wa2LabelResultSuffix(result);
    redirectWith(
      res,
      '/',
      'message',
      `Lead movido para ${STAGE_LABELS[stage]}.${suffix}${wa2Suffix}`,
    );
  } catch {
    redirectWith(res, '/', 'error', 'Não foi possível mover o lead.');
  }
});

app.get('/leads/:id/matriculate', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  try {
    const lead = await getLeadById(parsedId.data);
    if (!lead) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    if (!canTransition(lead.stage, STAGES.MATRICULATED)) {
      return redirectWith(res, '/', 'error', 'Este lead não pode ser matriculado nesta etapa.');
    }
    return res.send(matriculationConfirmView({
      lead,
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch {
    return redirectWith(res, '/', 'error', 'Não foi possível abrir a confirmação de matrícula.');
  }
});

app.post('/leads/:id/matriculate', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  if (req.body.confirmation !== 'MATRICULATION_COMPLETED') {
    return redirectWith(res, '/', 'error', 'Confirmação de matrícula inválida.');
  }
  try {
    const eventName = getStageEventName(STAGES.MATRICULATED);
    const result = await moveLeadStage(parsedId.data, STAGES.MATRICULATED, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      observation: 'Matrícula concluída por confirmação manual.',
      mode: currentMetaMode(),
    });
    if (!result) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    if (result.invalidTransition) {
      return redirectWith(res, '/', 'error', 'Transição para matrícula não permitida.');
    }
    const suffix = metaResultSuffix(eventName, result);
    const wa2Suffix = wa2LabelResultSuffix(result);
    return redirectWith(
      res,
      '/',
      'message',
      `Lead movido para ${STAGE_LABELS.MATRICULATED}.${suffix}${wa2Suffix}`,
    );
  } catch {
    return redirectWith(res, '/', 'error', 'Não foi possível concluir a matrícula.');
  }
});

app.get('/events', async (req, res) => {
  const [events, jobs] = await Promise.all([listRecentMetaEvents(), listRecentJobs()]);
  res.send(eventsView({
    events,
    jobs,
    message: req.query.message || '',
    error: req.query.error || '',
    csrfToken: issueCsrfToken(req, res),
  }));
});

app.post('/jobs/:id/retry', async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const retried = await retryFailedJob(id);
    if (!retried) {
      return redirectWith(res, '/events', 'error', 'Somente jobs com status FAILED podem ser reenviados.');
    }
    return redirectWith(res, '/events', 'message', 'Job FAILED reenfileirado com segurança.');
  } catch {
    return redirectWith(res, '/events', 'error', 'Não foi possível reenviar o job.');
  }
});

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Erro não tratado',
    error: error?.name || 'Error',
  }));
  if (error?.type === 'entity.too.large') {
    return res.status(413).send('Payload excede o limite permitido.');
  }
  if (error instanceof SyntaxError && error?.status === 400) {
    return res.status(400).send('Payload JSON inválido.');
  }
  return res.status(500).send('Erro interno. Consulte os logs.');
});

const port = Number(process.env.PORT || 3000);
validateServerConfig();
validateAuthConfig();
validateDatabaseConfig();
validateMetaConfig();
await migrate();
const server = app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'CRM Meta iniciado', port }));
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'CRM Meta encerrando', signal }));
  await new Promise((resolve) => server.close(resolve));
  await closePool();
}

process.on('SIGTERM', () => { stop('SIGTERM').catch(() => { process.exitCode = 1; }); });
process.on('SIGINT', () => { stop('SIGINT').catch(() => { process.exitCode = 1; }); });
