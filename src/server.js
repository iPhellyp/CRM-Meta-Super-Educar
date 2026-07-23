import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { z } from 'zod';
import {
  enqueueLeadgenJobs,
  getDashboardCounts,
  getLead,
  getQueueHealth,
  getWorkerHealth,
  healthcheck,
  listLeads,
  listRecentJobs,
  listRecentMetaEvents,
  migrate,
  moveLeadStage,
  operationStartAt,
  queueMetaConversionEvent,
  retryFailedJob,
  upsertLead,
} from './db.js';
import { clearSession, credentialsAreValid, requireAuth, setSession } from './auth.js';
import {
  currentMetaMode,
  getStageEventName,
  metaConfigStatus,
  verifyMetaSignature,
} from './meta.js';
import { dashboardView, eventsView, loginView } from './views.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = buffer; },
}));
app.use(cookieParser());
app.use(express.static('public', { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

function redirectWith(res, path, type, message) {
  const url = new URL(path, process.env.APP_URL || 'http://localhost:3000');
  url.searchParams.set(type, message);
  res.redirect(`${url.pathname}${url.search}`);
}

app.get('/health', async (_req, res) => {
  try {
    const [db, worker, queue] = await Promise.all([
      healthcheck(),
      getWorkerHealth(),
      getQueueHealth(),
    ]);
    res.json({
      ok: true,
      app: {
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        operationStartAt: operationStartAt()?.toISOString() || null,
      },
      database: { status: 'ok', checkedAt: db.now },
      worker: {
        status: worker.healthy ? 'ok' : 'unavailable',
        heartbeatAt: worker.heartbeatAt,
        startedAt: worker.startedAt,
      },
      meta: metaConfigStatus(),
      jobs: queue,
    });
  } catch {
    res.status(503).json({
      ok: false,
      app: { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) },
      database: { status: 'unavailable' },
      worker: { status: 'unknown' },
      meta: metaConfigStatus(),
      jobs: { pending: null, failed: null },
    });
  }
});

app.get('/login', (_req, res) => res.send(loginView()));
app.post('/login', (req, res) => {
  const email = String(req.body.email || '');
  const password = String(req.body.password || '');
  if (!credentialsAreValid(email, password)) {
    return res.status(401).send(loginView('E-mail ou senha inválidos.'));
  }
  setSession(res, email);
  res.redirect('/');
});
app.post('/logout', (_req, res) => {
  clearSession(res);
  res.redirect('/login');
});

app.get('/webhooks/meta/leadgen', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
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
    console.error(JSON.stringify({ level: 'error', msg: 'Falha ao registrar webhook leadgen', error: String(error) }));
    return res.status(503).json({ received: false });
  }
});

app.use(requireAuth);

app.get('/', async (req, res) => {
  const [leads, counts] = await Promise.all([listLeads(), getDashboardCounts()]);
  res.send(dashboardView({
    leads,
    counts,
    metaStatus: metaConfigStatus(),
    message: req.query.message || '',
    error: req.query.error || '',
    operationStartAt: operationStartAt(),
  }));
});

const leadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email().or(z.literal('')).optional(),
  course: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
  metaLeadId: z.string().trim().max(100).optional(),
});

app.post('/leads', async (req, res) => {
  try {
    const data = leadSchema.parse(req.body);
    await upsertLead({
      ...data,
      metaLeadId: data.metaLeadId || null,
      source: data.metaLeadId ? 'META_MANUAL_IMPORT' : 'MANUAL',
    });
    redirectWith(res, '/', 'message', 'Lead adicionado.');
  } catch (error) {
    redirectWith(res, '/', 'error', `Não foi possível adicionar: ${error.message}`);
  }
});

const allowedStages = new Set(['NEW', 'CONTACTED', 'QUALIFIED', 'OPPORTUNITY', 'MATRICULATED', 'LOST']);

app.post('/leads/:id/stage', async (req, res) => {
  const stage = String(req.body.stage || '');
  if (!allowedStages.has(stage)) return redirectWith(res, '/', 'error', 'Etapa inválida.');
  try {
    const eventName = getStageEventName(stage);
    const result = await moveLeadStage(req.params.id, stage, {
      origin: 'PANEL',
      eventName,
      mode: currentMetaMode(),
    });
    if (!result) return redirectWith(res, '/', 'error', 'Lead não encontrado.');
    let suffix = '';
    if (eventName) {
      suffix = result.event.status === 'SENT'
        ? ' O evento Meta já havia sido enviado.'
        : result.jobCreated
          ? ' Evento Meta enfileirado.'
          : ' Evento Meta já está na fila.';
    }
    redirectWith(res, '/', 'message', `Lead movido para ${stage}.${suffix}`);
  } catch (error) {
    redirectWith(res, '/', 'error', `Não foi possível mover o lead: ${String(error)}`);
  }
});

app.get('/events', async (req, res) => {
  const [events, jobs] = await Promise.all([listRecentMetaEvents(), listRecentJobs()]);
  res.send(eventsView({
    events,
    jobs,
    message: req.query.message || '',
    error: req.query.error || '',
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
  } catch (error) {
    return redirectWith(res, '/events', 'error', `Não foi possível reenviar: ${error.message}`);
  }
});

app.post('/api/meta/test/:leadId', async (req, res) => {
  try {
    const lead = await getLead(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const result = await queueMetaConversionEvent({
      lead,
      eventName: getStageEventName('QUALIFIED'),
      mode: currentMetaMode({ forceTest: true }),
    });
    res.status(result.event.status === 'SENT' ? 200 : 202).json({
      queued: result.jobCreated,
      duplicate: !result.jobCreated,
      eventId: result.event.event_id,
      status: result.event.status,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Erro não tratado', error: String(error), stack: error?.stack }));
  res.status(500).send('Erro interno. Consulte os logs.');
});

const port = Number(process.env.PORT || 3000);
await migrate();
app.listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'CRM Meta iniciado', port }));
});
