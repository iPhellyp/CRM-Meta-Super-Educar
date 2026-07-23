import crypto from 'node:crypto';
import { upsertLead } from './db.js';

const STAGE_EVENT = {
  QUALIFIED: 'Marketing Qualified Lead',
  OPPORTUNITY: 'Sales Opportunity',
  MATRICULATED: 'Converted',
};

const TEMPORARY_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

class MetaGraphError extends Error {
  constructor(message, { temporary = false } = {}) {
    super(message);
    this.name = 'MetaGraphError';
    this.temporary = temporary;
  }
}

function graphVersion() {
  return process.env.META_GRAPH_VERSION || 'v25.0';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function safeMetaError(payload, status) {
  return JSON.stringify({
    status,
    message: payload?.error?.message || 'Erro não identificado na Meta',
    type: payload?.error?.type,
    code: payload?.error?.code,
    subcode: payload?.error?.error_subcode,
    traceId: payload?.error?.fbtrace_id,
  });
}

function isTemporaryResponse(status, payload) {
  const code = Number(payload?.error?.code);
  return status === 408 ||
    status === 429 ||
    status >= 500 ||
    payload?.error?.is_transient === true ||
    TEMPORARY_META_CODES.has(code);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MetaGraphError(`Resposta inválida da Meta (HTTP ${response.status})`, {
      temporary: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
}

async function graphRequest(path, { fields, method = 'GET', body, token } = {}) {
  if (!token) throw new MetaGraphError('Token da Meta não configurado');
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${path}`);
  if (fields) url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 20_000),
    });
  } catch (error) {
    const networkError = new MetaGraphError(`Falha temporária de rede ao acessar a Meta: ${error.message}`, {
      temporary: true,
    });
    networkError.cause = error;
    throw networkError;
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new MetaGraphError(safeMetaError(payload, response.status), {
      temporary: isTemporaryResponse(response.status, payload),
    });
  }
  return payload;
}

export function getStageEventName(stage) {
  return STAGE_EVENT[stage] || null;
}

export function currentMetaMode({ forceTest = false } = {}) {
  return forceTest || process.env.META_TEST_MODE === 'true' ? 'test' : 'live';
}

export function metaConfigStatus() {
  const testMode = process.env.META_TEST_MODE === 'true';
  const required = [
    'META_DATASET_ID',
    'META_CAPI_ACCESS_TOKEN',
    'META_PAGE_ACCESS_TOKEN',
    'META_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
  ];
  if (testMode) required.push('META_TEST_EVENT_CODE');
  const missing = required.filter((key) => !process.env[key]);
  return {
    configured: missing.length === 0,
    missing,
    graphVersion: graphVersion(),
    testMode,
    signatureValidation: Boolean(process.env.META_APP_SECRET),
  };
}

export function verifyMetaSignature(req) {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.get('x-hub-signature-256');
  if (!appSecret || !signature || !req.rawBody) return false;
  if (!signature.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function fieldsToObject(fieldData = []) {
  const result = {};
  for (const item of fieldData) {
    const key = String(item.name || '').toLowerCase();
    const value = Array.isArray(item.values) ? item.values[0] : item.values;
    if (key) result[key] = value;
  }
  return result;
}

function firstValue(data, keys) {
  for (const key of keys) {
    if (data[key] != null && data[key] !== '') return String(data[key]);
  }
  return '';
}

export async function importLeadgenId(metaLeadId, webhookValue = {}) {
  const leadPayload = await graphRequest(String(metaLeadId), {
    fields: 'id,created_time,ad_id,form_id,field_data',
    token: process.env.META_PAGE_ACCESS_TOKEN,
  });
  const fields = fieldsToObject(leadPayload.field_data);

  let adPayload = {};
  if (leadPayload.ad_id) {
    try {
      adPayload = await graphRequest(String(leadPayload.ad_id), {
        fields: 'id,name,adset_id,campaign_id',
        token: process.env.META_PAGE_ACCESS_TOKEN,
      });
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'Não foi possível buscar atribuição opcional do anúncio',
        error: String(error),
      }));
    }
  }

  const name = firstValue(fields, ['full_name', 'nome_completo', 'name', 'nome']) || 'Lead Meta';
  const email = firstValue(fields, ['email', 'email_address']);
  const phone = firstValue(fields, ['phone_number', 'telefone', 'phone', 'celular']);
  const course = firstValue(fields, ['curso', 'course', 'qual_curso_voce_deseja', 'curso_de_interesse']);
  const city = firstValue(fields, ['city', 'cidade']);

  return upsertLead({
    name,
    email,
    phone,
    course,
    city,
    source: 'META_INSTANT_FORM',
    metaLeadId: String(metaLeadId),
    metaFormId: leadPayload.form_id
      ? String(leadPayload.form_id)
      : webhookValue.form_id
        ? String(webhookValue.form_id)
        : null,
    metaAdId: leadPayload.ad_id
      ? String(leadPayload.ad_id)
      : webhookValue.ad_id
        ? String(webhookValue.ad_id)
        : null,
    metaAdsetId: adPayload.adset_id ? String(adPayload.adset_id) : null,
    metaCampaignId: adPayload.campaign_id ? String(adPayload.campaign_id) : null,
    rawMeta: { lead: leadPayload, ad: adPayload, webhook: webhookValue },
  });
}

function buildUserData(lead) {
  const userData = {};
  if (lead.meta_lead_id) userData.lead_id = String(lead.meta_lead_id);
  const email = normalizeEmail(lead.email);
  const phone = normalizePhone(lead.phone);
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(phone)];
  return userData;
}

export async function sendMetaConversion(event) {
  const datasetId = process.env.META_DATASET_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!datasetId || !accessToken) {
    throw new MetaGraphError('META_DATASET_ID ou META_CAPI_ACCESS_TOKEN não configurado');
  }

  const testMode = event.event_id.endsWith(':test');
  if (testMode && !process.env.META_TEST_EVENT_CODE) {
    throw new MetaGraphError('Evento de teste pendente, mas META_TEST_EVENT_CODE está vazio');
  }

  const userData = buildUserData(event);
  if (!userData.lead_id && !userData.em && !userData.ph) {
    throw new MetaGraphError('Lead sem metaLeadId, email ou telefone para correspondência');
  }

  const body = {
    data: [
      {
        event_name: event.event_name,
        event_time: Math.floor(new Date(event.event_time).getTime() / 1000),
        event_id: event.event_id,
        action_source: 'system_generated',
        user_data: userData,
        custom_data: {
          event_source: 'crm',
          lead_event_source: process.env.META_LEAD_EVENT_SOURCE || 'Super Educar CRM',
        },
      },
    ],
  };
  if (testMode) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  return graphRequest(`${datasetId}/events`, {
    method: 'POST',
    body,
    token: accessToken,
  });
}

export function isTemporaryMetaError(error) {
  return error?.temporary === true;
}
