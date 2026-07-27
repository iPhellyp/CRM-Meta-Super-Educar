import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import {
  enqueueLeadgenJobs,
  closePool,
  getDashboardCounts,
  getLeadById,
  healthcheck,
  listLeads,
  listRecentJobs,
  listRecentMetaEvents,
  migrate,
  moveLeadStage,
  operationStartAt,
  retryFailedJob,
  upsertLead,
  validateDatabaseConfig,
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
  loginView,
  matriculationConfirmView,
  wa2DashboardView,
  wa2InstanceView,
  wa2QrView,
} from './views.js';
import {
  Wa2Error,
  connectWa2Instance,
  disconnectWa2Instance,
  getWa2Health,
  getWa2InstanceQr,
  getWa2InstanceStatus,
  listWa2Instances,
  syncWa2Instance,
  validateWa2InstanceId,
  wa2ConfigStatus,
} from './wa2.js';

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
    unavailable,
    message: req.query.message || '',
    error: req.query.error || '',
    csrfToken: issueCsrfToken(req, res),
  }));
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
    redirectWith(res, '/', 'message', `Lead movido para ${STAGE_LABELS[stage]}.${suffix}`);
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
    return redirectWith(res, '/', 'message', `Lead movido para ${STAGE_LABELS.MATRICULATED}.${suffix}`);
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
