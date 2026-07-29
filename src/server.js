import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { z } from 'zod';
import {
  Wa2DataError,
  createMetaConnection,
  createMetaHistoricalImport,
  createLeadFileImportPreview,
  cancelLeadFileImport,
  createWa2Reconciliation,
  createWa2ContactLink,
  decideWa2StageConfirmation,
  disableWa2Instance,
  enableWa2Instance,
  enqueueLeadgenJobs,
  enqueueLeadWa2Resync,
  closePool,
  getActiveWa2ContactLinkForLead,
  getDashboardCounts,
  getLeadById,
  getMetaConnectionById,
  getMetaSourceContext,
  getWa2ContactLinkById,
  getWa2InstanceLocalById,
  getWa2LabelBindingById,
  getWa2LabelJobCounts,
  getWa2LabelSyncStatusForLead,
  healthcheck,
  confirmLeadFileImport,
  listLeads,
  listLeadHistory,
  listMetaConnections,
  listMetaImportForms,
  listHistoricalOperations,
  listWa2InstancesLocal,
  listWa2LabelBindings,
  listWa2LabelJobs,
  listWa2ReconciliationItems,
  listRecentJobs,
  listRecentMetaEvents,
  moveLeadStage,
  operationStartAt,
  replaceWa2ContactLink,
  retryFailedJob,
  retryFailedWa2LabelJob,
  retryWa2ReconciliationFailures,
  recordWhatsAppOpened,
  replaceMetaConnectionAccessToken,
  setMetaHistoricalImportStatus,
  setMetaConnectionActive,
  setTenantWhatsAppMessage,
  setDefaultWa2Instance,
  setWa2LabelBindingEnabled,
  unlinkWa2ContactLink,
  upsertLead,
  upsertMetaDataset,
  upsertMetaForm,
  upsertMetaPage,
  upsertVerifiedWa2Instance,
  upsertWa2LabelBinding,
  validateDatabaseConfig,
  verifyWa2ContactLink,
  verifyWa2LabelBinding,
  getTenantWhatsAppMessage,
  updateMetaConnectionValidation,
  updateMetaConnectionName,
  updateMetaDatasetValidation,
} from './db.js';
import { runStartupMigrations } from './startup-migrations.js';
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
  listAccessibleMetaForms,
  listAccessibleMetaPages,
  metaConfigStatus,
  validateMetaAccessToken,
  validateMetaDataset,
  validateMetaConfig,
  verifyMetaSignature,
} from './meta.js';
import {
  LOST_REASON_LABELS,
  STAGE_LABELS,
  STAGES,
  getStageEventName,
  isDirectStageTarget,
} from './funnel.js';
import {
  dashboardView,
  eventsView,
  historicalOperationsView,
  leadFileImportPreviewView,
  leadFileSheetSelectionView,
  leadDetailView,
  loginView,
  metaConnectionsView,
  reconciliationItemsView,
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
import {
  getWhatsAppUrl,
  normalizeWhatsAppPhone,
  selectBestLeadPhone,
} from './phone.js';
import { decryptSecret, encryptSecret } from './secret-crypto.js';
import {
  createWa2ResolutionToken,
  wa2ResolutionTokenIsValid,
} from './wa2-link-token.js';
import { validateWa2ConfirmationState } from './wa2-link-rules.js';
import { isWa2LabelStage } from './wa2-label-sync.js';
import { createWhatsAppActionHandler } from './whatsapp-action.js';
import {
  LEAD_FILE_LIMITS,
  parseLeadFile,
  publicLeadFileImportError,
} from './lead-file-import.js';

const app = express();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LEAD_FILE_TIMEOUT_MS = 15_000;
const leadFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: LEAD_FILE_LIMITS.bytes,
    files: 1,
    fields: 2,
    parts: 3,
    fieldNameSize: 100,
    fieldSize: 2_000,
  },
});
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
  if (
    process.env.NODE_ENV === 'production' &&
    Buffer.from(process.env.META_CREDENTIALS_ENCRYPTION_KEY || '', 'base64').length !== 32
  ) {
    errors.push('META_CREDENTIALS_ENCRYPTION_KEY com 32 bytes em Base64');
  }
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

function parseCalendarDate(value, { endOfDay = false } = {}) {
  const raw = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return { raw: '', date: null };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { raw: '', date: null };
  }
  return {
    raw,
    date: new Date(
      `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`,
    ),
  };
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
  try {
    const leadgenChange = (req.body?.entry || [])
      .flatMap((entry) => (entry.changes || []).map((change) => ({ entry, change })))
      .find(({ change }) => change.field === 'leadgen');
    const pageId = leadgenChange?.change?.value?.page_id || leadgenChange?.entry?.id || null;
    const formId = leadgenChange?.change?.value?.form_id || null;
    const sourceContext = pageId
      ? await getMetaSourceContext({ pageId, formId })
      : null;
    const connectionSecret = sourceContext?.encrypted_app_secret
      ? decryptSecret(sourceContext.encrypted_app_secret)
      : null;
    if (!verifyMetaSignature(req, connectionSecret)) {
      return res.status(401).json({ error: 'Assinatura Meta inválida' });
    }
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

function singleLeadFile(req, res, next) {
  req.setTimeout(LEAD_FILE_TIMEOUT_MS);
  leadFileUpload.single('leadFile')(req, res, (error) => {
    if (!error) return next();
    const code = error instanceof multer.MulterError ? error.code : 'UPLOAD_FAILED';
    const message = code === 'LIMIT_FILE_SIZE'
      ? 'O arquivo excede 5 MB.'
      : code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Envie somente um arquivo no campo indicado.'
        : 'Não foi possível receber o arquivo.';
    return res.status(400).send(historicalOperationsView({
      operations: {
        cursor: null,
        imports: [],
        fileImports: [],
        reconciliations: [],
        conflicts: [],
        confirmations: [],
      },
      instances: [],
      metaForms: [],
      message: '',
      error: message,
      csrfToken: issueCsrfToken(req, res),
    }));
  });
}

function safeDashboardReturnPath(value) {
  const raw = String(value || '/');
  if (raw.length > 2_000 || /[\r\n]/.test(raw) || !raw.startsWith('/')) return '/';
  try {
    const url = new URL(raw, 'http://dashboard.local');
    return url.origin === 'http://dashboard.local' && url.pathname === '/'
      ? `${url.pathname}${url.search}`
      : '/';
  } catch {
    return '/';
  }
}

app.post(
  '/operations/file-imports/preview',
  singleLeadFile,
  requireCsrf,
  async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return redirectWith(res, '/operations', 'error', 'Selecione um arquivo CSV, XLSX ou XLS.');
      }
      const parsed = parseLeadFile(req.file.buffer, req.file.originalname, {
        sheetName: String(req.body.sheetName || ''),
      });
      const preview = await createLeadFileImportPreview(parsed, req.user.sub);
      return res.send(leadFileImportPreviewView({
        imported: preview,
        csrfToken: issueCsrfToken(req, res),
      }));
    } catch (error) {
      const safe = publicLeadFileImportError(error);
      if (safe.code === 'SHEET_SELECTION_REQUIRED') {
        return res.status(422).send(leadFileSheetSelectionView({
          sheets: safe.details.sheets || [],
          error: safe.message,
          csrfToken: issueCsrfToken(req, res),
        }));
      }
      console.error(JSON.stringify({
        level: 'warn',
        msg: 'Importação de arquivo rejeitada',
        code: safe.code,
      }));
      return redirectWith(res, '/operations', 'error', safe.message);
    } finally {
      if (req.file?.buffer) req.file.buffer.fill(0);
      if (req.file) req.file.buffer = null;
    }
  },
);

app.use((req, res, next) => req.method === 'POST' ? requireCsrf(req, res, next) : next());

app.post('/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/login');
});

const metaHistoricalIdsSchema = z.object({
  formRecordIds: z.union([
    z.string().uuid().transform((value) => [value]),
    z.array(z.string().uuid()).min(1).max(20),
  ]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
}).superRefine((value, context) => {
  if (value.periodStart && !parseCalendarDate(value.periodStart).date) {
    context.addIssue({ code: 'custom', path: ['periodStart'], message: 'Data inicial inválida' });
  }
  if (value.periodEnd && !parseCalendarDate(value.periodEnd).date) {
    context.addIssue({ code: 'custom', path: ['periodEnd'], message: 'Data final inválida' });
  }
  if (value.periodStart && value.periodEnd && value.periodEnd < value.periodStart) {
    context.addIssue({ code: 'custom', path: ['periodEnd'], message: 'Período inválido' });
  }
});

app.get('/operations', async (req, res) => {
  try {
    const [operations, instances, metaForms] = await Promise.all([
      listHistoricalOperations(),
      listWa2InstancesLocal(),
      listMetaImportForms(),
    ]);
    return res.send(historicalOperationsView({
      operations,
      instances,
      metaForms,
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
    return redirectWith(res, '/operations', 'error', 'Formulário ou período inválido.');
  }
  await createMetaHistoricalImport({
    formRecordIds: parsed.data.formRecordIds,
    periodStart: parsed.data.periodStart
      ? new Date(`${parsed.data.periodStart}T00:00:00.000Z`)
      : null,
    periodEnd: parsed.data.periodEnd
      ? new Date(`${parsed.data.periodEnd}T23:59:59.999Z`)
      : null,
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

app.post('/operations/file-imports/:id/confirm', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success || req.body.confirmation !== 'CONFIRM_LEAD_FILE_IMPORT') {
    return redirectWith(res, '/operations', 'error', 'Confirmação de importação inválida.');
  }
  try {
    const imported = await confirmLeadFileImport(id.data, req.user.sub);
    if (!imported) {
      return redirectWith(res, '/operations', 'error', 'Prévia não encontrada.');
    }
    if (imported.unavailable) {
      return redirectWith(res, '/operations', 'error', 'Esta importação não pode ser confirmada.');
    }
    const message = imported.idempotent
      ? `Importação já concluída: ${imported.counts.applied} lead(s) aplicado(s).`
      : `Importação concluída: ${imported.counts.applied} lead(s) aplicado(s).`;
    return redirectWith(res, '/operations', 'message', message);
  } catch {
    return redirectWith(res, '/operations', 'error', 'Não foi possível confirmar a importação.');
  }
});

app.post('/operations/file-imports/:id/cancel', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) {
    return redirectWith(res, '/operations', 'error', 'Prévia inválida.');
  }
  const cancelled = await cancelLeadFileImport(id.data);
  return redirectWith(
    res,
    '/operations',
    cancelled ? 'message' : 'error',
    cancelled ? 'Importação cancelada sem alterar leads.' : 'A importação não pode ser cancelada.',
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
  const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 10_000);
  const dateFrom = parseCalendarDate(req.query.dateFrom);
  const dateTo = parseCalendarDate(req.query.dateTo, { endOfDay: true });
  const filters = {
    search: String(req.query.search || '').trim().slice(0, 200),
    course: String(req.query.course || '').trim().slice(0, 200),
    city: String(req.query.city || '').trim().slice(0, 200),
    stage: String(req.query.stage || ''),
    lostReason: String(req.query.lostReason || ''),
    instanceId: String(req.query.instanceId || ''),
    labelId: String(req.query.labelId || '').trim().slice(0, 200),
    metaConnectionId: String(req.query.metaConnectionId || ''),
    businessId: String(req.query.businessId || '').trim().slice(0, 100),
    pageId: String(req.query.pageId || '').trim().slice(0, 100),
    formId: String(req.query.formId || '').trim().slice(0, 100),
    campaignId: String(req.query.campaignId || '').trim().slice(0, 200),
    adsetId: String(req.query.adsetId || '').trim().slice(0, 200),
    adId: String(req.query.adId || '').trim().slice(0, 200),
    attributed: ['yes', 'no'].includes(req.query.attributed) ? req.query.attributed : '',
    validPhone: ['yes', 'no'].includes(req.query.validPhone) ? req.query.validPhone : '',
    unattended: req.query.unattended === 'yes' ? 'yes' : '',
    dateFrom: dateFrom.raw,
    dateTo: dateTo.raw,
    createdAfter: dateFrom.date || operationStartAt(),
    createdBefore: dateTo.date,
    sort: ['recent', 'oldest', 'stage', 'unattended', 'updated', 'conversation'].includes(req.query.sort)
      ? req.query.sort
      : 'recent',
    page,
    limit: 101,
    offset: (page - 1) * 100,
  };
  if (!Object.hasOwn(STAGE_LABELS, filters.stage)) filters.stage = '';
  if (!Object.hasOwn(LOST_REASON_LABELS, filters.lostReason)) filters.lostReason = '';
  if (!z.string().uuid().safeParse(filters.instanceId).success) filters.instanceId = '';
  if (!z.string().uuid().safeParse(filters.metaConnectionId).success) {
    filters.metaConnectionId = '';
  }
  const [leadRows, counts, wa2Instances, metaConnections, whatsappMessage] = await Promise.all([
    listLeads(filters),
    getDashboardCounts(),
    listWa2InstancesLocal({ enabledOnly: true }),
    listMetaConnections(),
    getTenantWhatsAppMessage(),
  ]);
  const leads = leadRows.slice(0, 100);
  const baseMetaStatus = metaConfigStatus();
  const hasValidMetaConnection = metaConnections.some(
    (connection) => connection.active && connection.status === 'VALID',
  );
  res.send(dashboardView({
    leads,
    counts,
    metaStatus: hasValidMetaConnection
      ? { ...baseMetaStatus, configured: true, missing: [] }
      : baseMetaStatus,
    message: req.query.message || '',
    error: req.query.error || '',
    operationStartAt: operationStartAt(),
    filters,
    pagination: {
      page,
      hasNext: leadRows.length > 100,
    },
    wa2Instances,
    metaConnections,
    whatsappMessage,
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
  const returnPath = safeDashboardReturnPath(req.body.returnTo);
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, returnPath, 'error', 'Lead inválido.');
  const stage = String(req.body.stage || '');
  if (!isDirectStageTarget(stage)) {
    return redirectWith(res, returnPath, 'error', 'Etapa inválida.');
  }
  if (['LOST', 'NO_INTEREST', 'INVALID_PHONE', 'DUPLICATED'].includes(stage)) {
    return redirectWith(res, returnPath, 'error', 'Use a ação Perder e informe o motivo obrigatório.');
  }
  try {
    const eventName = getStageEventName(stage);
    const result = await moveLeadStage(parsedId.data, stage, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      mode: currentMetaMode(),
    });
    if (!result) return redirectWith(res, returnPath, 'error', 'Lead não encontrado.');
    if (result.invalidTransition) {
      return redirectWith(res, returnPath, 'error', 'Transição de etapa não permitida.');
    }
    const suffix = metaResultSuffix(eventName, result);
    const wa2Suffix = wa2LabelResultSuffix(result);
    redirectWith(
      res,
      returnPath,
      'message',
      `Lead movido para ${STAGE_LABELS[stage]}.${suffix}${wa2Suffix}`,
    );
  } catch {
    redirectWith(res, returnPath, 'error', 'Não foi possível mover o lead.');
  }
});

app.post('/settings/whatsapp-message', async (req, res) => {
  const message = z.string().trim().min(1).max(1000).safeParse(req.body.message);
  if (!message.success || !message.data.includes('{{nome}}')) {
    return redirectWith(
      res,
      '/',
      'error',
      'A mensagem deve ter até 1.000 caracteres e incluir {{nome}}.',
    );
  }
  await setTenantWhatsAppMessage(message.data);
  return redirectWith(res, '/', 'message', 'Mensagem inicial do WhatsApp atualizada.');
});

const reconciliationResults = new Set([
  'MATCHED', 'UPDATED', 'PHONE_EMPTY', 'PHONE_INVALID', 'NOT_FOUND_IN_WA2',
  'LID_UNRESOLVED', 'LABEL_UNMAPPED', 'CONFLICT', 'ERROR',
]);

app.get('/operations/reconciliations/:id/items', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const result = String(req.query.result || '');
  if (!id.success || (result && !reconciliationResults.has(result))) {
    return redirectWith(res, '/operations', 'error', 'Filtro de reconciliação inválido.');
  }
  const items = await listWa2ReconciliationItems({
    runId: id.data,
    result: result || null,
  });
  return res.send(reconciliationItemsView({
    runId: id.data,
    result,
    items,
    csrfToken: issueCsrfToken(req, res),
  }));
});

app.get('/operations/reconciliations/:id/errors.csv', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(400).send('Job inválido.');
  const items = await listWa2ReconciliationItems({ runId: id.data, limit: 1000 });
  const errors = items.filter((item) => [
    'PHONE_EMPTY', 'PHONE_INVALID', 'NOT_FOUND_IN_WA2', 'LID_UNRESOLVED',
    'LABEL_UNMAPPED', 'CONFLICT', 'ERROR',
  ].includes(item.result));
  const rows = [
    ['Job', 'Lead ID', 'Lead', 'Resultado', 'Código', 'Tentativas'],
    ...errors.map((item) => [
      item.run_id, item.lead_id, item.lead_name, item.result,
      item.last_error_code, item.attempts,
    ]),
  ];
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="reconciliacao-${id.data}.csv"`);
  return res.send(`\ufeff${rows.map((row) => row.map(csvCell).join(';')).join('\n')}`);
});

app.post('/wa2/labels/sync', async (req, res) => {
  const parsedInstanceId = z.string().uuid().safeParse(req.body.instanceId);
  if (!parsedInstanceId.success) {
    return redirectWith(res, '/wa2/labels', 'error', 'Instância inválida.');
  }
  try {
    await createWa2Reconciliation({
      instanceId: parsedInstanceId.data,
      actor: req.user.sub,
    });
    return redirectWith(
      res,
      `/wa2/labels?instanceId=${parsedInstanceId.data}`,
      'message',
      'Sincronização WA2 enfileirada.',
    );
  } catch (error) {
    return redirectWith(
      res,
      `/wa2/labels?instanceId=${parsedInstanceId.data}`,
      'error',
      wa2LinkErrorMessage(error),
    );
  }
});

const metaConnectionSchema = z.object({
  name: z.string().trim().min(2).max(200),
  businessId: z.string().regex(/^[0-9]{1,100}$/),
  adAccountId: z.string().regex(/^[0-9]{1,100}$/).or(z.literal('')).optional(),
  appId: z.string().regex(/^[0-9]{1,100}$/).or(z.literal('')).optional(),
  accessToken: z.string().trim().min(20).max(10_000),
  appSecret: z.string().trim().max(10_000).optional(),
});

app.get('/meta/connections', async (req, res) => {
  try {
    const connections = await listMetaConnections();
    const parsedId = z.string().uuid().safeParse(req.query.connectionId);
    const selected = parsedId.success ? await getMetaConnectionById(parsedId.data) : null;
    let remotePages = [];
    let remoteForms = [];
    const selectedPageId = String(req.query.pageId || '');
    if (selected && req.query.discover === 'pages') {
      remotePages = await listAccessibleMetaPages(
        decryptSecret(selected.encrypted_access_token),
      );
    }
    if (
      selected &&
      req.query.discover === 'forms' &&
      /^\d{1,100}$/.test(selectedPageId) &&
      selected.pages.some((page) => page.page_id === selectedPageId)
    ) {
      remoteForms = await listAccessibleMetaForms(
        selectedPageId,
        decryptSecret(selected.encrypted_access_token),
      );
    }
    return res.send(metaConnectionsView({
      connections,
      selected,
      remotePages,
      remoteForms,
      selectedPageId,
      message: req.query.message || '',
      error: req.query.error || '',
      csrfToken: issueCsrfToken(req, res),
    }));
  } catch {
    return res.send(metaConnectionsView({
      connections: await listMetaConnections(),
      error: 'Não foi possível consultar a Meta. Nenhuma credencial foi exibida.',
      csrfToken: issueCsrfToken(req, res),
    }));
  }
});

app.post('/meta/connections', async (req, res) => {
  const parsed = metaConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    return redirectWith(res, '/meta/connections', 'error', 'Dados da conexão inválidos.');
  }
  try {
    await validateMetaAccessToken(parsed.data.accessToken);
    const connection = await createMetaConnection({
      ...parsed.data,
      encryptedAccessToken: encryptSecret(parsed.data.accessToken),
      encryptedAppSecret: parsed.data.appSecret
        ? encryptSecret(parsed.data.appSecret)
        : null,
    });
    await updateMetaConnectionValidation(connection.id, {
      status: 'VALID',
      validated: true,
    });
    return redirectWith(
      res,
      `/meta/connections?connectionId=${connection.id}`,
      'message',
      'Conexão Meta validada e salva com credenciais criptografadas.',
    );
  } catch {
    return redirectWith(
      res,
      '/meta/connections',
      'error',
      'Não foi possível validar ou salvar a conexão Meta.',
    );
  }
});

app.post('/meta/connections/:id/active', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const active = req.body.active === 'true';
  if (!parsedId.success || (!active && req.body.confirmation !== 'DEACTIVATE_META_CONNECTION')) {
    return redirectWith(res, '/meta/connections', 'error', 'Confirmação inválida.');
  }
  await setMetaConnectionActive(parsedId.data, active);
  return redirectWith(res, '/meta/connections', 'message', active
    ? 'Conexão Meta ativada.'
    : 'Conexão Meta desativada sem apagar o histórico.');
});

app.post('/meta/connections/:id/name', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const name = z.string().trim().min(2).max(200).safeParse(req.body.name);
  if (!parsedId.success || !name.success) {
    return redirectWith(res, '/meta/connections', 'error', 'Nome da conexão inválido.');
  }
  const updated = await updateMetaConnectionName(parsedId.data, name.data);
  if (!updated) return redirectWith(res, '/meta/connections', 'error', 'Conexão não encontrada.');
  return redirectWith(
    res,
    `/meta/connections?connectionId=${updated.id}`,
    'message',
    'Nome da conexão atualizado.',
  );
});

app.post('/meta/connections/:id/pages', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const pageId = String(req.body.pageId || '');
  if (!parsedId.success || !/^\d{1,100}$/.test(pageId)) {
    return redirectWith(res, '/meta/connections', 'error', 'Página inválida.');
  }
  try {
    const connection = await getMetaConnectionById(parsedId.data);
    if (!connection?.active) throw new Error('Conexão inativa');
    const pages = await listAccessibleMetaPages(decryptSecret(connection.encrypted_access_token));
    const page = pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error('Página não pertence ao token');
    await upsertMetaPage({ connectionId: connection.id, pageId: page.id, name: page.name });
    return redirectWith(
      res,
      `/meta/connections?connectionId=${connection.id}`,
      'message',
      'Página confirmada na Meta e vinculada.',
    );
  } catch {
    return redirectWith(res, '/meta/connections', 'error', 'Não foi possível validar a página.');
  }
});

app.post('/meta/connections/:id/forms', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const pageRecordId = z.string().uuid().safeParse(req.body.pageRecordId);
  const pageId = String(req.body.pageId || '');
  const formId = String(req.body.formId || '');
  if (
    !parsedId.success ||
    !pageRecordId.success ||
    !/^\d{1,100}$/.test(pageId) ||
    !/^\d{1,100}$/.test(formId)
  ) {
    return redirectWith(res, '/meta/connections', 'error', 'Formulário inválido.');
  }
  try {
    const connection = await getMetaConnectionById(parsedId.data);
    const page = connection?.pages.find(
      (candidate) => candidate.id === pageRecordId.data && candidate.page_id === pageId,
    );
    if (!connection?.active || !page) throw new Error('Página inválida');
    const forms = await listAccessibleMetaForms(
      pageId,
      decryptSecret(connection.encrypted_access_token),
    );
    const form = forms.find((candidate) => candidate.id === formId);
    if (!form) throw new Error('Formulário não pertence à página');
    await upsertMetaForm({ pageRecordId: page.id, formId: form.id, name: form.name });
    return redirectWith(
      res,
      `/meta/connections?connectionId=${connection.id}`,
      'message',
      'Formulário confirmado na Meta e vinculado.',
    );
  } catch {
    return redirectWith(res, '/meta/connections', 'error', 'Não foi possível validar o formulário.');
  }
});

app.post('/meta/connections/:id/datasets', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const parsed = z.object({
    datasetId: z.string().regex(/^[0-9]{1,100}$/),
    name: z.string().trim().min(1).max(200),
    testEventCode: z.string().trim().max(100).optional(),
  }).safeParse(req.body);
  if (!parsedId.success || !parsed.success) {
    return redirectWith(res, '/meta/connections', 'error', 'Dataset inválido.');
  }
  try {
    await upsertMetaDataset({
      connectionId: parsedId.data,
      datasetId: parsed.data.datasetId,
      name: parsed.data.name,
      encryptedTestEventCode: parsed.data.testEventCode
        ? encryptSecret(parsed.data.testEventCode)
        : null,
    });
    return redirectWith(
      res,
      `/meta/connections?connectionId=${parsedId.data}`,
      'message',
      'Dataset salvo para esta conexão.',
    );
  } catch {
    return redirectWith(res, '/meta/connections', 'error', 'Não foi possível salvar o dataset.');
  }
});

app.post('/meta/connections/:connectionId/datasets/:datasetId/validate', async (req, res) => {
  const connectionId = z.string().uuid().safeParse(req.params.connectionId);
  const datasetRecordId = z.string().uuid().safeParse(req.params.datasetId);
  if (!connectionId.success || !datasetRecordId.success) {
    return redirectWith(res, '/meta/connections', 'error', 'Dataset inválido.');
  }
  let dataset = null;
  try {
    const connection = await getMetaConnectionById(connectionId.data);
    dataset = connection?.datasets.find(
      (candidate) => candidate.id === datasetRecordId.data && candidate.active,
    );
    if (!connection?.active || connection.status !== 'VALID' || !dataset) {
      throw new Error('Conexão ou dataset indisponível');
    }
    await validateMetaDataset(
      dataset.dataset_id,
      decryptSecret(connection.encrypted_access_token),
    );
    await updateMetaDatasetValidation(dataset.id, { valid: true });
    return redirectWith(
      res,
      `/meta/connections?connectionId=${connection.id}`,
      'message',
      'Dataset validado com a Meta sem enviar evento fictício.',
    );
  } catch {
    if (dataset) {
      await updateMetaDatasetValidation(dataset.id, {
        valid: false,
        errorMessage: 'Não foi possível confirmar o dataset com esta conexão.',
      });
    }
    return redirectWith(
      res,
      `/meta/connections?connectionId=${connectionId.data}`,
      'error',
      'Não foi possível validar o dataset.',
    );
  }
});

app.post('/meta/connections/:id/token', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const token = z.string().trim().min(20).max(10_000).safeParse(req.body.accessToken);
  if (!parsedId.success || !token.success) {
    return redirectWith(res, '/meta/connections', 'error', 'Token inválido.');
  }
  try {
    await validateMetaAccessToken(token.data);
    await replaceMetaConnectionAccessToken(parsedId.data, encryptSecret(token.data));
    return redirectWith(
      res,
      `/meta/connections?connectionId=${parsedId.data}`,
      'message',
      'Token validado e renovado.',
    );
  } catch {
    return redirectWith(res, '/meta/connections', 'error', 'Não foi possível renovar o token.');
  }
});

const lostLeadSchema = z.object({
  lostReason: z.enum(Object.keys(LOST_REASON_LABELS)),
  lostNotes: z.string().trim().max(1000).optional(),
}).superRefine((value, context) => {
  if (value.lostReason === 'OTHER' && !value.lostNotes) {
    context.addIssue({ code: 'custom', path: ['lostNotes'], message: 'Observação obrigatória' });
  }
});

app.post('/leads/:id/lost', async (req, res) => {
  const returnPath = safeDashboardReturnPath(req.body.returnTo);
  const parsedId = z.string().uuid().safeParse(req.params.id);
  const parsed = lostLeadSchema.safeParse(req.body);
  if (!parsedId.success || !parsed.success) {
    return redirectWith(res, returnPath, 'error', 'Informe um motivo de perda válido.');
  }
  try {
    const stageByReason = {
      NO_INTEREST: STAGES.NO_INTEREST,
      NO_RESPONSE: STAGES.LOST,
      INVALID_PHONE: STAGES.INVALID_PHONE,
      DUPLICATED: STAGES.DUPLICATED,
    };
    const stage = stageByReason[parsed.data.lostReason] || STAGES.LOST;
    const result = await moveLeadStage(parsedId.data, stage, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      lostReason: parsed.data.lostReason,
      lostNotes: parsed.data.lostNotes || null,
      observation: `Perda registrada: ${LOST_REASON_LABELS[parsed.data.lostReason]}.`,
      mode: currentMetaMode(),
    });
    if (!result || result.invalidTransition) {
      return redirectWith(res, returnPath, 'error', 'Transição para perda não permitida.');
    }
    return redirectWith(res, returnPath, 'message', 'Perda registrada com motivo e sem evento positivo.');
  } catch {
    return redirectWith(res, returnPath, 'error', 'Não foi possível registrar a perda.');
  }
});

app.post('/leads/:id/whatsapp', createWhatsAppActionHandler({
  getLeadById,
  getTenantWhatsAppMessage,
  getWhatsAppUrl,
  recordWhatsAppOpened,
  selectBestLeadPhone,
}));

app.get('/leads/:id', async (req, res, next) => {
  if (req.params.id === 'export.csv') return next();
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  const [lead, history] = await Promise.all([
    getLeadById(parsedId.data),
    listLeadHistory(parsedId.data),
  ]);
  if (!lead) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
  return res.send(leadDetailView({
    lead,
    history,
    csrfToken: issueCsrfToken(req, res),
  }));
});

app.post('/leads/bulk', async (req, res) => {
  const returnPath = safeDashboardReturnPath(req.body.returnTo);
  const rawIds = Array.isArray(req.body.leadIds)
    ? req.body.leadIds
    : req.body.leadIds
      ? [req.body.leadIds]
      : [];
  const parsedIds = z.array(z.string().uuid()).min(1).max(100).safeParse(rawIds);
  const stage = String(req.body.stage || '');
  const bulkAction = String(req.body.bulkAction || 'stage');
  const lostReason = String(req.body.lostReason || '');
  const lostNotes = String(req.body.lostNotes || '').trim().slice(0, 1000);
  const lossStage = [
    STAGES.LOST, STAGES.NO_INTEREST, STAGES.INVALID_PHONE, STAGES.DUPLICATED,
  ].includes(stage);
  if (
    !parsedIds.success ||
    !['stage', 'sync'].includes(bulkAction) ||
    (bulkAction === 'stage' && !isDirectStageTarget(stage)) ||
    (lossStage && !Object.hasOwn(LOST_REASON_LABELS, lostReason)) ||
    (lossStage && lostReason === 'OTHER' && !lostNotes)
  ) {
    return redirectWith(res, returnPath, 'error', 'Seleção ou etapa em lote inválida.');
  }
  let changed = 0;
  for (const id of parsedIds.data) {
    if (bulkAction === 'sync') {
      const sync = await enqueueLeadWa2Resync(id, req.user.sub);
      if (sync?.scheduled > 0) changed += 1;
      continue;
    }
    const result = await moveLeadStage(id, stage, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      observation: 'Alteração comercial em lote.',
      metadata: { bulk: true },
      lostReason: lossStage ? lostReason : null,
      lostNotes: lossStage ? lostNotes || null : null,
      mode: currentMetaMode(),
    });
    if (result?.stageChanged) changed += 1;
  }
  return redirectWith(
    res,
    returnPath,
    'message',
    bulkAction === 'sync'
      ? `${changed} sincronização(ões) WA2 enfileirada(s).`
      : `${changed} lead(s) atualizado(s) em lote.`,
  );
});

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""').replace(/[\r\n]+/g, ' ')}"`;
}

app.get('/leads/export.csv', async (req, res) => {
  const instanceId = z.string().uuid().safeParse(req.query.instanceId);
  const metaConnectionId = z.string().uuid().safeParse(req.query.metaConnectionId);
  const dateFrom = parseCalendarDate(req.query.dateFrom);
  const dateTo = parseCalendarDate(req.query.dateTo, { endOfDay: true });
  const leads = await listLeads({
    search: String(req.query.search || '').slice(0, 200),
    course: String(req.query.course || '').slice(0, 200),
    city: String(req.query.city || '').slice(0, 200),
    stage: Object.hasOwn(STAGE_LABELS, req.query.stage) ? req.query.stage : '',
    lostReason: Object.hasOwn(LOST_REASON_LABELS, req.query.lostReason)
      ? req.query.lostReason
      : '',
    instanceId: instanceId.success ? instanceId.data : '',
    labelId: String(req.query.labelId || '').slice(0, 200),
    metaConnectionId: metaConnectionId.success ? metaConnectionId.data : '',
    businessId: String(req.query.businessId || '').slice(0, 100),
    pageId: String(req.query.pageId || '').slice(0, 100),
    formId: String(req.query.formId || '').slice(0, 100),
    campaignId: String(req.query.campaignId || '').slice(0, 200),
    adsetId: String(req.query.adsetId || '').slice(0, 200),
    adId: String(req.query.adId || '').slice(0, 200),
    attributed: ['yes', 'no'].includes(req.query.attributed) ? req.query.attributed : '',
    validPhone: ['yes', 'no'].includes(req.query.validPhone) ? req.query.validPhone : '',
    unattended: req.query.unattended === 'yes' ? 'yes' : '',
    createdAfter: dateFrom.date || operationStartAt(),
    createdBefore: dateTo.date,
    limit: 200,
  });
  const rows = [
    ['Nome', 'Telefone', 'E-mail', 'Curso', 'Cidade', 'Etapa', 'Motivo da perda', 'Meta Lead ID'],
    ...leads.map((lead) => [
      lead.name, lead.phone, lead.email, lead.course, lead.city,
      STAGE_LABELS[lead.stage] || lead.stage,
      LOST_REASON_LABELS[lead.lost_reason] || lead.lost_reason,
      lead.meta_lead_id,
    ]),
  ];
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', 'attachment; filename="leads.csv"');
  return res.send(`\ufeff${rows.map((row) => row.map(csvCell).join(';')).join('\n')}`);
});

app.get('/leads/:id/matriculate', async (req, res) => {
  return redirectWith(
    res,
    '/',
    'error',
    'Matrícula só pode ser confirmada pelo sistema de origem. Use Aguardando matrícula.',
  );
});

app.post('/leads/:id/matriculate', async (req, res) => {
  return redirectWith(
    res,
    '/',
    'error',
    'Confirmação manual de matrícula foi desativada por segurança.',
  );
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
    errorName: error?.name || 'Error',
    errorMessage: process.env.NODE_ENV === 'development'
      ? error?.message || String(error)
      : undefined,
    errorCode: process.env.NODE_ENV === 'development'
      ? error?.code || null
      : undefined,
    stack: process.env.NODE_ENV === 'development'
      ? error?.stack
      : undefined,
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
await runStartupMigrations();
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
