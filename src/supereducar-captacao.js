import { normalizeWhatsAppPhoneOrNull } from './phone.js';
import { WEBSITE_SOURCE } from './website-lead-ingest.js';

export const SUPEREDUCAR_CAPTACAO_DEFAULT_URL = 'https://supereducar.com/api/captacao-interesse';
export const SUPEREDUCAR_CAPTACAO_DEFAULT_INTERVAL_MS = 5 * 60_000;
export const SUPEREDUCAR_CAPTACAO_TIMEZONE_OFFSET = '-03:00';
export const SUPEREDUCAR_CAPTACAO_STAGE = 'NEW';

const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_ID_LENGTH = 64;
const MAX_OPTION_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class SupereducarCaptacaoError extends Error {
  constructor(code, message = code, { status = null, transient = false } = {}) {
    super(message);
    this.name = 'SupereducarCaptacaoError';
    this.code = code;
    this.status = status;
    this.transient = transient;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertSafeText(value, maxLength) {
  if (typeof value !== 'string') {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  return normalized;
}

function normalizeApiDate(value) {
  const raw = assertSafeText(value, 80);
  const localDateMatch = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/,
  );
  const candidate = localDateMatch
    ? `${localDateMatch[1]}T${localDateMatch[2]}:${localDateMatch[3] || '00'}.${(localDateMatch[4] || '000').padEnd(3, '0')}${SUPEREDUCAR_CAPTACAO_TIMEZONE_OFFSET}`
    : raw;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  return date.toISOString();
}

function normalizeExternalId(value) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!/^\d+$/.test(raw) || raw.length > MAX_ID_LENGTH || Number(raw) <= 0) {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  return raw;
}

export function supereducarCaptacaoConfig(env = process.env) {
  const url = String(
    env.SUPEREDUCAR_CAPTACAO_API_URL || SUPEREDUCAR_CAPTACAO_DEFAULT_URL,
  ).trim();
  const token = String(env.SUPEREDUCAR_CAPTACAO_API_TOKEN || '').trim();
  const startAfterId = String(env.SUPEREDUCAR_CAPTACAO_START_AFTER_ID || '').trim();
  const validStartAfterId = /^\d+$/.test(startAfterId)
    && startAfterId.length <= MAX_ID_LENGTH
    && BigInt(startAfterId) >= 0n;
  let validUrl = false;
  try {
    const parsed = new URL(url);
    validUrl = parsed.protocol === 'https:';
  } catch {
    validUrl = false;
  }
  return {
    url,
    token,
    intervalMs: Math.min(
      positiveInteger(
        env.SUPEREDUCAR_CAPTACAO_SYNC_INTERVAL_MS,
        SUPEREDUCAR_CAPTACAO_DEFAULT_INTERVAL_MS,
      ),
      MAX_INTERVAL_MS,
    ),
    startAfterId: validStartAfterId ? startAfterId : null,
    enabled: Boolean(token && validUrl && validStartAfterId),
  };
}

export function mapSupereducarCaptacaoRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  const externalId = normalizeExternalId(record.id);
  const interest = assertSafeText(record.opcao, MAX_OPTION_LENGTH);
  const phone = assertSafeText(record.celular, 60);
  if (!normalizeWhatsAppPhoneOrNull(phone)) {
    throw new SupereducarCaptacaoError('INVALID_RECORD');
  }
  return {
    external_lead_id: `supereducar-site-${externalId}`,
    interest,
    phone,
    submitted_at: normalizeApiDate(record.data),
    attribution: {},
    source: WEBSITE_SOURCE,
    stage: SUPEREDUCAR_CAPTACAO_STAGE,
  };
}

function apiErrorForStatus(status) {
  if (status === 401 || status === 403) {
    return new SupereducarCaptacaoError('AUTHENTICATION_ERROR', 'API authentication failed', {
      status,
    });
  }
  if (status === 429) {
    return new SupereducarCaptacaoError('RATE_LIMIT', 'API rate limit', {
      status,
      transient: true,
    });
  }
  if (status >= 500) {
    return new SupereducarCaptacaoError('REMOTE_5XX', 'Remote API unavailable', {
      status,
      transient: true,
    });
  }
  return new SupereducarCaptacaoError('HTTP_ERROR', 'Remote API request failed', { status });
}

async function fetchCaptacaoRecords({ config, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(config.url, {
      method: 'GET',
      headers: { 'X-Api-Token': config.token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new SupereducarCaptacaoError(
      timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      timeout ? 'Remote API timeout' : 'Remote API network error',
      { transient: true },
    );
  }

  const rawBody = await response.text();
  if (!response.ok) throw apiErrorForStatus(response.status);

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new SupereducarCaptacaoError('INVALID_JSON');
  }
  if (body?.status !== 'ok' || !Array.isArray(body?.dados)) {
    throw new SupereducarCaptacaoError('INVALID_RESPONSE');
  }
  return {
    total: Number.isInteger(body.total) ? body.total : null,
    records: body.dados,
  };
}

function emptySummary(status = 'ok') {
  return {
    status,
    code: null,
    httpStatus: null,
    transient: false,
    total: null,
    fetched: 0,
    ignoredBeforeCutoff: 0,
    created: 0,
    replayed: 0,
    skipped: 0,
    failed: 0,
    errors: {},
  };
}

function incrementError(summary, code) {
  summary.errors[code] = (summary.errors[code] || 0) + 1;
}

export async function syncSupereducarCaptacao({
  config = supereducarCaptacaoConfig(),
  fetchImpl = globalThis.fetch,
  ingest,
} = {}) {
  if (!config.enabled) {
    return { ...emptySummary('disabled'), code: 'NOT_CONFIGURED' };
  }
  if (typeof fetchImpl !== 'function' || typeof ingest !== 'function') {
    return { ...emptySummary('error'), code: 'DEPENDENCY_NOT_CONFIGURED' };
  }
  if (config.startAfterId == null) {
    return { ...emptySummary('disabled'), code: 'CUTOFF_NOT_CONFIGURED' };
  }

  let response;
  try {
    response = await fetchCaptacaoRecords({ config, fetchImpl });
  } catch (error) {
    return {
      ...emptySummary('error'),
      code: error.code || 'REMOTE_ERROR',
      httpStatus: error.status || null,
      transient: error.transient === true,
    };
  }

  const summary = emptySummary('ok');
  summary.total = response.total;
  summary.fetched = response.records.length;
  summary.ignoredBeforeCutoff = 0;
  for (const record of response.records) {
    const rawId = typeof record?.id === 'number' && Number.isSafeInteger(record.id)
      ? String(record.id)
      : typeof record?.id === 'string'
        ? record.id.trim()
        : null;
    if (/^\d+$/.test(rawId || '') && BigInt(rawId) <= BigInt(config.startAfterId)) {
      summary.ignoredBeforeCutoff += 1;
      continue;
    }
    try {
      const payload = mapSupereducarCaptacaoRecord(record);
      const result = await ingest(payload);
      if (result?.code === 'IDEMPOTENT_REPLAY' || result?.created === false) {
        summary.replayed += 1;
      } else {
        summary.created += 1;
      }
    } catch (error) {
      const code = error?.code === 'EXTERNAL_ID_CONFLICT'
        ? 'EXTERNAL_ID_CONFLICT'
        : error?.code === 'INVALID_RECORD'
          ? 'INVALID_RECORD'
          : 'PERSISTENCE_ERROR';
      if (code === 'INVALID_RECORD') summary.skipped += 1;
      else summary.failed += 1;
      incrementError(summary, code);
    }
  }
  return summary;
}
