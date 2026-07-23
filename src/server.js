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
  getStageEventName,
  metaConfigStatus,
  validateMetaConfig,
  verifyMetaSignature,
} from './meta.js';
import { dashboardView, eventsView, loginView } from './views.js';

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

const allowedStages = new Set(['NEW', 'CONTACTED', 'QUALIFIED', 'OPPORTUNITY', 'MATRICULATED', 'LOST']);

app.post('/leads/:id/stage', async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return redirectWith(res, '/', 'error', 'Lead inválido.');
  const stage = String(req.body.stage || '');
  if (!allowedStages.has(stage)) return redirectWith(res, '/', 'error', 'Etapa inválida.');
  try {
    const eventName = getStageEventName(stage);
    const result = await moveLeadStage(parsedId.data, stage, {
      origin: 'MANUAL',
      changedBy: req.user.sub,
      eventName,
      mode: currentMetaMode(),
    });
    if (!result) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    let suffix = '';
    if (eventName && !result.attributed) {
      suffix = ' Lead sem atribuição Meta; nenhum evento foi criado.';
    } else if (eventName) {
      suffix = result.event.status === 'SENT'
        ? ' O evento Meta já havia sido enviado.'
        : result.jobCreated
          ? ' Evento Meta enfileirado.'
          : ' Evento Meta já está na fila.';
    }
    redirectWith(res, '/', 'message', `Lead movido para ${stage}.${suffix}`);
  } catch {
    redirectWith(res, '/', 'error', 'Não foi possível mover o lead.');
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
