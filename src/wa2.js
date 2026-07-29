import crypto from 'node:crypto';
import { normalizeWhatsAppPhone } from './phone.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QR_BYTES = 512 * 1024;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CONNECT_MODES = new Set(['auto', 'resume', 'new_qr']);
const SYNC_SCOPES = new Set(['quick', 'catalog', 'history']);
const LABEL_EVENT_OPERATIONS = new Set(['APPLY', 'REMOVE']);
const LABEL_EVENT_SOURCES = new Set(['INTERNAL_API', 'WHATSAPP', 'UNKNOWN']);

export class Wa2Error extends Error {
  constructor(message, {
    code = 'WA2_ERROR',
    status = null,
    requestId = null,
    retryAfter = null,
    remoteCode = null,
  } = {}) {
    super(message);
    this.name = 'Wa2Error';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.remoteCode = remoteCode;
  }
}

function parseTimeout(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(raw);
  return Number.isSafeInteger(timeout) && timeout >= MIN_TIMEOUT_MS && timeout <= MAX_TIMEOUT_MS
    ? timeout
    : null;
}

function parseBaseUrl(value, nodeEnv) {
  try {
    const url = new URL(String(value || ''));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    if (nodeEnv === 'production' && url.protocol !== 'https:') return null;
    if (
      url.protocol === 'http:' &&
      !['development', 'test'].includes(nodeEnv) &&
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function wa2ConfigStatus(env = process.env) {
  const hasBaseUrl = Boolean(String(env.WA2_INTERNAL_API_BASE_URL || '').trim());
  const hasSecret = Boolean(String(env.WA2_INTERNAL_API_SECRET || '').trim());
  const timeoutMs = parseTimeout(env.WA2_INTERNAL_API_TIMEOUT_MS);

  if (!hasBaseUrl && !hasSecret && timeoutMs) {
    return {
      state: 'disabled',
      enabled: false,
      configured: false,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      errors: timeoutMs ? [] : ['Timeout inválido'],
    };
  }

  const errors = [];
  if (hasBaseUrl !== hasSecret) errors.push('Base URL e segredo devem ser configurados juntos');
  const baseUrl = hasBaseUrl
    ? parseBaseUrl(env.WA2_INTERNAL_API_BASE_URL, env.NODE_ENV)
    : null;
  if (hasBaseUrl && !baseUrl) errors.push('Base URL inválida para o ambiente');
  if (!timeoutMs) errors.push('Timeout inválido');

  return {
    state: errors.length ? 'invalid' : 'configured',
    enabled: errors.length === 0,
    configured: errors.length === 0,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    errors,
  };
}

export function validateWa2Config(env = process.env) {
  const status = wa2ConfigStatus(env);
  if (status.state === 'disabled') return status;
  if (status.state === 'invalid') {
    throw new Wa2Error('Configuração WA2 inválida', { code: 'WA2_CONFIG_INVALID' });
  }
  return status;
}

export function validateWa2InstanceId(instanceId) {
  const value = String(instanceId || '');
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw new Wa2Error('Identificador de instância inválido', {
      code: 'WA2_INSTANCE_ID_INVALID',
    });
  }
  return value;
}

function safeRetryAfter(value) {
  const text = String(value || '').trim();
  if (/^\d{1,5}$/.test(text) && Number(text) <= 86_400) return text;
  if (text.length <= 64 && !Number.isNaN(Date.parse(text))) return text;
  return null;
}

function safeRemoteCode(payload) {
  const value = payload?.error?.code ?? payload?.code;
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(text) ? text : null;
}

function objectPayload(payload) {
  const value = payload?.data ?? payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Wa2Error('Resposta WA2 incompatível', { code: 'WA2_RESPONSE_INVALID' });
  }
  return value;
}

function safeText(value, maxLength = 200) {
  if (value == null) return null;
  return String(value).slice(0, maxLength);
}

export function classifyWa2Jid(value) {
  const jid = String(value || '').trim().toLowerCase();
  if (!jid) return 'unsupported';
  if (jid === 'status@broadcast') return 'status';
  if (jid.endsWith('@lid')) return 'lid';
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.includes('newsletter') || jid.includes('channel')) return 'newsletter';
  if (jid.includes('broadcast')) return 'broadcast';
  if (/^\d+@(s\.whatsapp\.net|c\.us)$/.test(jid)) return 'individual_phone';
  return 'unsupported';
}

function individualJidPhone(value) {
  const jid = String(value || '').trim().toLowerCase();
  const type = classifyWa2Jid(jid);
  if (type !== 'individual_phone') {
    const code = {
      lid: 'WA2_LID_UNRESOLVED',
      group: 'WA2_GROUP_UNSUPPORTED',
      broadcast: 'WA2_BROADCAST_UNSUPPORTED',
      status: 'WA2_BROADCAST_UNSUPPORTED',
      newsletter: 'WA2_BROADCAST_UNSUPPORTED',
    }[type] || 'WA2_UNSUPPORTED_JID';
    throw new Wa2Error('JID WA2 não representa contato individual', {
      code,
    });
  }
  return {
    jid,
    phoneNormalized: jid.slice(0, jid.indexOf('@')),
  };
}

function brazilianPhoneAliases(phoneNormalized) {
  const aliases = new Set([phoneNormalized]);
  if (!/^55\d{10,11}$/.test(phoneNormalized)) return aliases;
  if (phoneNormalized.length === 12) {
    aliases.add(`${phoneNormalized.slice(0, 4)}9${phoneNormalized.slice(4)}`);
  } else if (phoneNormalized[4] === '9') {
    aliases.add(`${phoneNormalized.slice(0, 4)}${phoneNormalized.slice(5)}`);
  }
  return aliases;
}

function sameResolvedPhone(requestedPhone, resolvedPhone) {
  return brazilianPhoneAliases(requestedPhone).has(resolvedPhone);
}

function validateNormalizedPhone(value) {
  const phone = String(value || '');
  if (!phone || normalizeWhatsAppPhone(phone) !== phone) {
    throw new Wa2Error('Telefone não está normalizado', {
      code: 'WA2_PHONE_INVALID',
    });
  }
  return phone;
}

function requiredRemoteText(value, maxLength, code = 'WA2_RESPONSE_INVALID') {
  if (typeof value !== 'string') {
    throw new Wa2Error('Resposta WA2 incompatível', { code });
  }
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new Wa2Error('Resposta WA2 incompatível', { code });
  }
  return text;
}

function optionalRemoteText(value, maxLength, code = 'WA2_RESPONSE_INVALID') {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Wa2Error('Resposta WA2 incompatível', { code });
  }
  return value;
}

function validateWa2ResourceId(value, field) {
  const text = String(value || '');
  if (!RESOURCE_ID_PATTERN.test(text)) {
    throw new Wa2Error(`Identificador de ${field} inválido`, {
      code: 'WA2_RESOURCE_ID_INVALID',
    });
  }
  return text;
}

function sanitizeLabel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Wa2Error('Etiqueta WA2 incompatível', { code: 'WA2_LABEL_INVALID' });
  }
  return {
    id: validateWa2ResourceId(
      requiredRemoteText(value.waLabelId, 128, 'WA2_LABEL_INVALID'),
      'etiqueta',
    ),
    name: requiredRemoteText(value.name, 200, 'WA2_LABEL_INVALID'),
  };
}

function sanitizeLabels(payload) {
  const value = objectPayload(payload);
  if (!Array.isArray(value.labels)) {
    throw new Wa2Error('Lista de etiquetas WA2 incompatível', {
      code: 'WA2_LABELS_INVALID',
    });
  }
  return value.labels.map(sanitizeLabel);
}

function sanitizeLabelEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Wa2Error('Evento de etiqueta WA2 incompatível', {
      code: 'WA2_LABEL_EVENT_INVALID',
    });
  }
  const eventId = requiredRemoteText(value.eventId, 36, 'WA2_LABEL_EVENT_INVALID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
    throw new Wa2Error('Evento de etiqueta WA2 incompatível', {
      code: 'WA2_LABEL_EVENT_INVALID',
    });
  }
  const instanceId = validateWa2InstanceId(
    requiredRemoteText(value.instanceId, 128, 'WA2_LABEL_EVENT_INVALID'),
  );
  const chatId = validateWa2ResourceId(
    requiredRemoteText(value.chatId, 128, 'WA2_LABEL_EVENT_INVALID'),
    'chat',
  );
  const jid = requiredRemoteText(value.jid, 255, 'WA2_LABEL_EVENT_INVALID').toLowerCase();
  const jidType = classifyWa2Jid(jid);
  const phoneNormalized = value.phoneNormalized == null
    ? null
    : validateNormalizedPhone(value.phoneNormalized);
  if (
    !LABEL_EVENT_OPERATIONS.has(value.operation) ||
    !LABEL_EVENT_SOURCES.has(value.source) ||
    typeof value.eligibleForCrm !== 'boolean'
  ) {
    throw new Wa2Error('Evento de etiqueta WA2 incompatível', {
      code: 'WA2_LABEL_EVENT_INVALID',
    });
  }
  const observedAt = parseIsoDate(value.observedAt);
  if (!observedAt) {
    throw new Wa2Error('Evento de etiqueta WA2 incompatível', {
      code: 'WA2_LABEL_EVENT_INVALID',
    });
  }
  if (
    value.eligibleForCrm &&
    (
      !phoneNormalized ||
      !['individual_phone', 'lid'].includes(jidType) ||
      (
        jidType === 'individual_phone' &&
        individualJidPhone(jid).phoneNormalized !== phoneNormalized
      )
    )
  ) {
    throw new Wa2Error('Elegibilidade WA2 divergente do contato', {
      code: 'WA2_LABEL_EVENT_INVALID',
    });
  }
  return {
    eventId,
    instanceId,
    chatId,
    jid,
    phoneNormalized,
    waLabelId: validateWa2ResourceId(
      requiredRemoteText(value.waLabelId, 128, 'WA2_LABEL_EVENT_INVALID'),
      'etiqueta',
    ),
    operation: value.operation,
    source: value.source,
    observedAt: observedAt.toISOString(),
    eligibleForCrm: value.eligibleForCrm,
    ineligibleReason: optionalRemoteText(
      value.ineligibleReason,
      80,
      'WA2_LABEL_EVENT_INVALID',
    ),
  };
}

function sanitizeLabelEvents(payload) {
  const value = objectPayload(payload);
  if (!Array.isArray(value.events) || typeof value.hasMore !== 'boolean') {
    throw new Wa2Error('Feed de etiquetas WA2 incompatível', {
      code: 'WA2_LABEL_EVENTS_INVALID',
    });
  }
  const nextCursor = value.nextCursor == null
    ? null
    : requiredRemoteText(value.nextCursor, 500, 'WA2_LABEL_EVENTS_INVALID');
  return {
    events: value.events.map(sanitizeLabelEvent),
    nextCursor,
    hasMore: value.hasMore,
  };
}

function sanitizeLabelMutation(payload, expectedOperation) {
  const value = objectPayload(payload);
  if (
    value.operation !== expectedOperation ||
    typeof value.changed !== 'boolean' ||
    typeof value.enqueued !== 'boolean' ||
    !Object.hasOwn(value, 'jobId')
  ) {
    throw new Wa2Error('Mutação de etiqueta WA2 incompatível', {
      code: 'WA2_LABEL_MUTATION_INVALID',
    });
  }
  return {
    operation: value.operation,
    changed: value.changed,
    enqueued: value.enqueued,
    jobId: sanitizeJobId(value.jobId),
  };
}

function sanitizeContactByPhone(payload, requestedPhone) {
  const value = objectPayload(payload);
  if (!value.contact || typeof value.contact !== 'object' || Array.isArray(value.contact)) {
    throw new Wa2Error('Contato WA2 ausente na resposta', {
      code: 'WA2_CONTACT_INVALID',
    });
  }
  const contactId = requiredRemoteText(value.contact.id, 200, 'WA2_CONTACT_INVALID');
  const phoneNormalized = requiredRemoteText(
    value.contact.phoneNormalized,
    20,
    'WA2_CONTACT_INVALID',
  );
  if (phoneNormalized !== requestedPhone) {
    throw new Wa2Error('Telefone retornado pelo WA2 é divergente', {
      code: 'WA2_PHONE_MISMATCH',
    });
  }
  const contactJid = individualJidPhone(value.contact.jid);
  if (!sameResolvedPhone(requestedPhone, contactJid.phoneNormalized)) {
    throw new Wa2Error('JID do contato diverge do telefone', {
      code: 'WA2_JID_MISMATCH',
    });
  }

  let chat = null;
  if (value.chat != null) {
    if (typeof value.chat !== 'object' || Array.isArray(value.chat)) {
      throw new Wa2Error('Chat WA2 incompatível', { code: 'WA2_CHAT_INVALID' });
    }
    const chatId = requiredRemoteText(value.chat.id, 200, 'WA2_CHAT_INVALID');
    if (classifyWa2Jid(value.chat.jid) === 'lid') {
      chat = {
        id: chatId,
        jid: requiredRemoteText(value.chat.jid, 200, 'WA2_CHAT_INVALID'),
      };
    } else {
      const chatJid = individualJidPhone(value.chat.jid);
      if (
        !sameResolvedPhone(requestedPhone, chatJid.phoneNormalized) ||
        chatJid.phoneNormalized !== contactJid.phoneNormalized
      ) {
        throw new Wa2Error('JID do chat diverge do contato', {
          code: 'WA2_JID_MISMATCH',
        });
      }
      chat = { id: chatId, jid: chatJid.jid };
    }
  }
  const resolution = ['EXACT', 'ALIAS', 'LID_HISTORICAL'].includes(value.resolution)
    ? value.resolution
    : null;
  if (typeof value.labeledCrm !== 'boolean' && value.labeledCrm != null) {
    throw new Wa2Error('Classificação do contato WA2 incompatível', {
      code: 'WA2_CONTACT_INVALID',
    });
  }

  return {
    contact: {
      id: contactId,
      phoneNormalized,
      name: optionalRemoteText(value.contact.name, 200, 'WA2_CONTACT_INVALID'),
      jid: contactJid.jid,
    },
    chat,
    ...(resolution ? { resolution } : {}),
    ...(typeof value.labeledCrm === 'boolean' ? { labeledCrm: value.labeledCrm } : {}),
  };
}

function sanitizeLabeledIdentities(payload) {
  const value = payload?.data ?? payload;
  if (!Array.isArray(value)) {
    throw new Wa2Error('Identidades etiquetadas WA2 incompatíveis', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Wa2Error('Identidade etiquetada WA2 incompatível', {
        code: 'WA2_RESPONSE_INVALID',
      });
    }
    return {
      chatId: validateWa2ResourceId(item.chatId, 'chat'),
      phoneNormalized: item.phoneNormalized == null
        ? null
        : validateNormalizedPhone(item.phoneNormalized),
      resolution: ['PN', 'LID_HISTORICAL', 'LID_UNRESOLVED'].includes(item.resolution)
        ? item.resolution
        : 'LID_UNRESOLVED',
      labels: Array.isArray(item.labels) ? item.labels.map(sanitizeLabel) : [],
    };
  });
}

function sanitizeHealth(payload) {
  const value = objectPayload(payload);
  if (typeof value.ok !== 'boolean' && typeof value.status !== 'string') {
    throw new Wa2Error('Resposta de health incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return {
    ok: value.ok === true,
    status: safeText(value.status, 40),
    service: safeText(value.service, 100),
    version: safeText(value.version, 40),
  };
}

function sanitizeInstance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Wa2Error('Resposta de instância incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  const id = safeText(value.id ?? value.instanceId, 128);
  if (!id || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Wa2Error('Resposta de instância incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return {
    id,
    name: safeText(value.name, 200),
    role: safeText(value.role, 80),
    phone: safeText(value.phone, 40),
    status: safeText(value.status, 40),
    isDefault: value.isDefault === true,
    updatedAt: safeText(value.updatedAt, 50),
  };
}

function sanitizeInstances(payload) {
  const value = payload?.data ?? payload;
  const instances = Array.isArray(value)
    ? value
    : Array.isArray(value?.instances)
      ? value.instances
      : null;
  if (!instances) {
    throw new Wa2Error('Resposta de instâncias incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return instances.map(sanitizeInstance);
}

function sanitizeStatus(payload) {
  const value = objectPayload(payload);
  if (typeof value.status !== 'string' || !value.status.trim()) {
    throw new Wa2Error('Resposta de status incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return {
    instanceId: safeText(value.instanceId ?? value.id, 128),
    name: safeText(value.name, 200),
    phone: safeText(value.phone, 40),
    status: safeText(value.status, 40),
    connectedAt: safeText(value.connectedAt, 50),
    lastSyncAt: safeText(value.lastSyncAt, 50),
    requiresQr: value.requiresQr === true,
    lastErrorCode: safeText(value.lastErrorCode, 80),
    updatedAt: safeText(value.updatedAt, 50),
  };
}

function sanitizeJobId(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Wa2Error('Resposta de operação incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return value;
}

function sanitizeMutation(payload, operation) {
  const value = objectPayload(payload);
  const instanceId = safeText(value.instanceId, 128);
  if (!instanceId || !INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Wa2Error('Resposta de operação incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  if (!Object.hasOwn(value, 'jobId')) {
    throw new Wa2Error('Resposta de operação incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  const jobId = sanitizeJobId(value.jobId);

  if (operation === 'sync') {
    if (!SYNC_SCOPES.has(value.scope) || typeof value.deduped !== 'boolean') {
      throw new Wa2Error('Resposta de sincronização incompatível', {
        code: 'WA2_RESPONSE_INVALID',
      });
    }
    return {
      instanceId,
      scope: value.scope,
      jobId,
      deduped: value.deduped,
    };
  }

  const allowedStatuses = operation === 'connect'
    ? new Set(['connecting', 'connected'])
    : new Set(['disconnecting', 'disconnected']);
  if (!allowedStatuses.has(value.status) || typeof value.enqueued !== 'boolean') {
    throw new Wa2Error('Resposta de operação incompatível', {
      code: 'WA2_RESPONSE_INVALID',
    });
  }
  return {
    instanceId,
    status: value.status,
    enqueued: value.enqueued,
    jobId,
  };
}

function strictBase64ToBuffer(value) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Wa2Error('QR recebido em formato inválido', { code: 'WA2_QR_INVALID' });
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Wa2Error('QR recebido em formato inválido', { code: 'WA2_QR_INVALID' });
  }
  if (bytes.length > MAX_QR_BYTES) {
    throw new Wa2Error('QR excede o limite permitido', { code: 'WA2_QR_TOO_LARGE' });
  }
  return bytes;
}

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseWa2Qr(payload, { now = new Date() } = {}) {
  const value = objectPayload(payload);
  const dataUrl = value.qrCode;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_QR_BYTES * 1.5) {
    throw new Wa2Error('QR recebido em formato inválido', { code: 'WA2_QR_INVALID' });
  }
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) {
    throw new Wa2Error('QR recebido em formato inválido', { code: 'WA2_QR_INVALID' });
  }
  const expiresAt = parseIsoDate(value.expiresAt);
  if (!expiresAt) {
    throw new Wa2Error('Validade do QR incompatível', { code: 'WA2_QR_INVALID' });
  }
  const updatedAt = value.updatedAt == null ? null : parseIsoDate(value.updatedAt);
  if (value.updatedAt != null && !updatedAt) {
    throw new Wa2Error('Data de atualização do QR incompatível', {
      code: 'WA2_QR_INVALID',
    });
  }
  if (
    value.expiresAtHeuristic != null &&
    typeof value.expiresAtHeuristic !== 'boolean'
  ) {
    throw new Wa2Error('Indicador de validade do QR incompatível', {
      code: 'WA2_QR_INVALID',
    });
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Wa2Error('QR expirado', { code: 'WA2_QR_EXPIRED' });
  }
  const bytes = strictBase64ToBuffer(match[2]);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < pngSignature.length || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Wa2Error('QR recebido em formato inválido', { code: 'WA2_QR_INVALID' });
  }
  return {
    bytes,
    contentType: match[1],
    expiresAt: expiresAt.toISOString(),
    expiresAtHeuristic: value.expiresAtHeuristic === true,
    updatedAt: updatedAt?.toISOString() || null,
  };
}

async function readLimitedJson(response, requestId) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Wa2Error('Resposta WA2 excede o limite permitido', {
      code: 'WA2_RESPONSE_TOO_LARGE',
      requestId,
    });
  }
  const chunks = [];
  let totalBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Wa2Error('Resposta WA2 excede o limite permitido', {
          code: 'WA2_RESPONSE_TOO_LARGE',
          requestId,
        });
      }
      chunks.push(Buffer.from(value));
    }
  }
  const buffer = Buffer.concat(chunks, totalBytes);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Wa2Error('Resposta WA2 inválida', {
      code: 'WA2_RESPONSE_INVALID',
      requestId,
      status: response.status,
    });
  }
}

export function createWa2Client({
  env = process.env,
  fetchImpl = globalThis.fetch,
  randomUUID = crypto.randomUUID,
} = {}) {
  const config = validateWa2Config(env);
  if (config.state === 'disabled') {
    throw new Wa2Error('Integração WA2 desativada', { code: 'WA2_DISABLED' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new Wa2Error('Cliente HTTP indisponível', { code: 'WA2_FETCH_UNAVAILABLE' });
  }
  const baseUrl = parseBaseUrl(env.WA2_INTERNAL_API_BASE_URL, env.NODE_ENV);
  const secret = String(env.WA2_INTERNAL_API_SECRET);

  async function request(path, {
    method = 'GET',
    body,
    parse = objectPayload,
    idempotencyKey = null,
  } = {}) {
    const requestId = randomUUID();
    const mutation = method !== 'GET';
    const mutationKey = mutation ? (idempotencyKey || randomUUID()) : null;
    if (mutation && !IDEMPOTENCY_KEY_PATTERN.test(mutationKey)) {
      throw new Wa2Error('Idempotency-Key inválida', {
        code: 'WA2_IDEMPOTENCY_KEY_INVALID',
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${secret}`,
      'x-request-id': requestId,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (mutation) headers['idempotency-key'] = mutationKey;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      clearTimeout(timeout);
      throw new Wa2Error(
        timedOut ? 'WA2 não respondeu dentro do prazo' : 'WA2 indisponível',
        {
          code: timedOut ? 'WA2_TIMEOUT' : 'WA2_UNAVAILABLE',
          requestId,
        },
      );
    }

    try {
      const payload = await readLimitedJson(response, requestId);
      if (!response.ok) {
        throw new Wa2Error(`WA2 respondeu com HTTP ${response.status}`, {
          code: 'WA2_HTTP_ERROR',
          status: response.status,
          requestId,
          retryAfter: safeRetryAfter(response.headers.get('retry-after')),
          remoteCode: safeRemoteCode(payload),
        });
      }
      try {
        return parse(payload);
      } catch (error) {
        if (error instanceof Wa2Error) {
          if (!error.requestId) error.requestId = requestId;
          throw error;
        }
        throw new Wa2Error('Resposta WA2 incompatível', {
          code: 'WA2_RESPONSE_INVALID',
          requestId,
        });
      }
    } catch (error) {
      if (error instanceof Wa2Error) throw error;
      throw new Wa2Error(
        controller.signal.aborted ? 'WA2 não respondeu dentro do prazo' : 'Resposta WA2 inválida',
        {
          code: controller.signal.aborted ? 'WA2_TIMEOUT' : 'WA2_RESPONSE_INVALID',
          requestId,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  const instancePath = (instanceId, suffix) => {
    const id = validateWa2InstanceId(instanceId);
    return `/api/internal/v1/instances/${encodeURIComponent(id)}${suffix}`;
  };

  return {
    getHealth: () => request('/api/internal/v1/health', { parse: sanitizeHealth }),
    listInstances: () => request('/api/internal/v1/instances', { parse: sanitizeInstances }),
    listLabelEvents: ({ after = null, limit = 100 } = {}) => {
      if (
        (after != null && !/^[A-Za-z0-9_-]{1,500}$/.test(String(after))) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw new Wa2Error('Paginação do feed WA2 inválida', {
          code: 'WA2_LABEL_EVENTS_PAGE_INVALID',
        });
      }
      const search = new URLSearchParams({ limit: String(limit) });
      if (after) search.set('after', String(after));
      return request(`/api/internal/v1/label-events?${search}`, {
        parse: sanitizeLabelEvents,
      });
    },
    getInstanceStatus: (instanceId) => request(instancePath(instanceId, '/status'), {
      parse: sanitizeStatus,
    }),
    getInstanceQr: (instanceId) => request(instancePath(instanceId, '/qr'), {
      parse: parseWa2Qr,
    }),
    getContactByPhone: (instanceId, phoneNormalized) => {
      const phone = validateNormalizedPhone(phoneNormalized);
      return request(instancePath(
        instanceId,
        `/contacts/by-phone/${encodeURIComponent(phone)}`,
      ), {
        parse: (payload) => sanitizeContactByPhone(payload, phone),
      });
    },
    listLabeledIdentities: (instanceId) => request(
      instancePath(instanceId, '/identities/labeled'),
      { parse: sanitizeLabeledIdentities },
    ),
    listLabels: (instanceId) => request(instancePath(instanceId, '/labels'), {
      parse: sanitizeLabels,
    }),
    listChatLabels: (instanceId, chatId) => {
      const chat = validateWa2ResourceId(chatId, 'chat');
      return request(instancePath(
        instanceId,
        `/chats/${encodeURIComponent(chat)}/labels`,
      ), { parse: sanitizeLabels });
    },
    applyChatLabel: (instanceId, chatId, labelId, { idempotencyKey } = {}) => {
      const chat = validateWa2ResourceId(chatId, 'chat');
      const label = validateWa2ResourceId(labelId, 'etiqueta');
      return request(instancePath(
        instanceId,
        `/chats/${encodeURIComponent(chat)}/labels/${encodeURIComponent(label)}`,
      ), {
        method: 'PUT',
        idempotencyKey,
        parse: (payload) => sanitizeLabelMutation(payload, 'apply'),
      });
    },
    removeChatLabel: (instanceId, chatId, labelId, { idempotencyKey } = {}) => {
      const chat = validateWa2ResourceId(chatId, 'chat');
      const label = validateWa2ResourceId(labelId, 'etiqueta');
      return request(instancePath(
        instanceId,
        `/chats/${encodeURIComponent(chat)}/labels/${encodeURIComponent(label)}`,
      ), {
        method: 'DELETE',
        idempotencyKey,
        parse: (payload) => sanitizeLabelMutation(payload, 'remove'),
      });
    },
    connectInstance: (instanceId, mode) => {
      if (!CONNECT_MODES.has(mode)) {
        throw new Wa2Error('Modo de conexão inválido', { code: 'WA2_CONNECT_MODE_INVALID' });
      }
      return request(instancePath(instanceId, '/connect'), {
        method: 'POST',
        body: { mode },
        parse: (payload) => sanitizeMutation(payload, 'connect'),
      });
    },
    syncInstance: (instanceId, scope) => {
      if (!SYNC_SCOPES.has(scope)) {
        throw new Wa2Error('Escopo de sincronização inválido', { code: 'WA2_SYNC_SCOPE_INVALID' });
      }
      return request(instancePath(instanceId, '/sync'), {
        method: 'POST',
        body: { scope },
        parse: (payload) => sanitizeMutation(payload, 'sync'),
      });
    },
    disconnectInstance: (instanceId) => request(instancePath(instanceId, '/disconnect'), {
      method: 'POST',
      body: { preserveSession: true },
      parse: (payload) => sanitizeMutation(payload, 'disconnect'),
    }),
  };
}

function defaultClient(options) {
  return createWa2Client(options);
}

export const getWa2Health = (options) => defaultClient(options).getHealth();
export const listWa2Instances = (options) => defaultClient(options).listInstances();
export const listWa2LabelEvents = (page, options) =>
  defaultClient(options).listLabelEvents(page);
export const getWa2InstanceStatus = (instanceId, options) =>
  defaultClient(options).getInstanceStatus(instanceId);
export const getWa2InstanceQr = (instanceId, options) =>
  defaultClient(options).getInstanceQr(instanceId);
export const getWa2ContactByPhone = (instanceId, phoneNormalized, options) =>
  defaultClient(options).getContactByPhone(instanceId, phoneNormalized);
export const listWa2LabeledIdentities = (instanceId, options) =>
  defaultClient(options).listLabeledIdentities(instanceId);
export const listWa2Labels = (instanceId, options) =>
  defaultClient(options).listLabels(instanceId);
export const listWa2ChatLabels = (instanceId, chatId, options) =>
  defaultClient(options).listChatLabels(instanceId, chatId);
export const applyWa2ChatLabel = (instanceId, chatId, labelId, options = {}) => {
  const { idempotencyKey, ...clientOptions } = options;
  return defaultClient(clientOptions).applyChatLabel(
    instanceId,
    chatId,
    labelId,
    { idempotencyKey },
  );
};
export const removeWa2ChatLabel = (instanceId, chatId, labelId, options = {}) => {
  const { idempotencyKey, ...clientOptions } = options;
  return defaultClient(clientOptions).removeChatLabel(
    instanceId,
    chatId,
    labelId,
    { idempotencyKey },
  );
};
export const connectWa2Instance = (instanceId, mode, options) =>
  defaultClient(options).connectInstance(instanceId, mode);
export const syncWa2Instance = (instanceId, scope, options) =>
  defaultClient(options).syncInstance(instanceId, scope);
export const disconnectWa2Instance = (instanceId, options) =>
  defaultClient(options).disconnectInstance(instanceId);
