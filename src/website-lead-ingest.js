import crypto from 'node:crypto';
import {
  normalizeWhatsAppPhoneOrNull,
} from './phone.js';

export const WEBSITE_INGEST_ROUTE = '/api/integrations/supereducar/website-leads';
export const WEBSITE_INTEGRATION = 'supereducar-website';
export const WEBSITE_EXTERNAL_SYSTEM = 'SUPEREDUCAR_WEBSITE';
export const WEBSITE_SOURCE = 'WEBSITE_FORM';
export const WEBSITE_DEFAULT_CLOCK_SKEW_SECONDS = 300;
export const WEBSITE_RATE_LIMIT = 60;
export const WEBSITE_RATE_WINDOW_MS = 60_000;

const TEXT_FIELDS = new Set([
  'course_id', 'course_name', 'modality', 'name', 'fbclid', 'fbp', 'fbc',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'campaign_id', 'adset_id', 'ad_id',
]);
const URL_FIELDS = new Set(['landing_page_url', 'referrer_url']);
const ALLOWED_FIELDS = new Set([
  'external_lead_id', 'website_submission_id', 'interest', 'course_id',
  'course_name', 'modality', 'name', 'phone', 'email', 'fbclid', 'fbp', 'fbc',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'campaign_id', 'adset_id', 'ad_id', 'landing_page_url', 'referrer_url',
  'consent_at', 'submitted_at', 'attribution',
]);
const LEGACY_ATTRIBUTION_FIELDS = [
  'fbclid', 'fbp', 'fbc', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id',
  'landing_page_url', 'referrer_url', 'consent_at',
];
const UNIVERSAL_ATTRIBUTION_FIELDS = new Set([
  'provider', 'source', 'medium', 'channel',
  'campaign_id', 'campaign_name',
  'ad_group_id', 'ad_group_name',
  'adset_id', 'adset_name',
  'ad_id', 'ad_name',
  'creative_id', 'creative_name',
  'placement', 'keyword', 'match_type',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'landing_page_url', 'referrer_url', 'consent_at',
  'click_ids', 'extra',
]);
const ATTRIBUTION_LABEL_FIELDS = new Set([
  'provider', 'source', 'medium', 'channel', 'match_type',
  'utm_source', 'utm_medium',
]);
const ATTRIBUTION_URL_FIELDS = new Set(['landing_page_url', 'referrer_url']);
const ATTRIBUTION_DATE_FIELDS = new Set(['consent_at']);
const ATTRIBUTION_MAX_BYTES = 8 * 1024;
const CLICK_IDS_MAX_KEYS = 32;
const CLICK_ID_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/i;
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class WebsiteIngestError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'WebsiteIngestError';
    this.code = code;
  }
}

function fail(code) {
  throw new WebsiteIngestError(code);
}

function normalizeOptionalString(value, field, maxLength = 200) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_PAYLOAD');
  const normalized = value.trim();
  if (normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) fail('INVALID_PAYLOAD');
  return normalized || null;
}

function normalizeRequiredString(value, field, maxLength = 200) {
  if (typeof value !== 'string') fail('INVALID_PAYLOAD');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) fail('INVALID_PAYLOAD');
  return normalized;
}

function normalizeIsoDate(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) fail('INVALID_PAYLOAD');
    return null;
  }
  if (typeof value !== 'string') fail('INVALID_PAYLOAD');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_PAYLOAD');
  return date.toISOString();
}

function normalizeUrl(value) {
  const normalized = normalizeOptionalString(value, 'url', 2048);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) fail('INVALID_PAYLOAD');
    return url.toString();
  } catch {
    fail('INVALID_PAYLOAD');
  }
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertSafeRecord(value) {
  if (!isPlainRecord(value)) fail('INVALID_PAYLOAD');
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key.toLowerCase())) fail('INVALID_PAYLOAD');
  }
}

function normalizeAttributionOptionalString(value, maxLength = 200, { lowercase = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_PAYLOAD');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    fail('INVALID_PAYLOAD');
  }
  return lowercase ? normalized.toLowerCase() : normalized;
}

function normalizeProvider(value) {
  const provider = normalizeAttributionOptionalString(value, 64, { lowercase: true });
  if (provider && !/^[a-z0-9][a-z0-9._-]*$/.test(provider)) fail('INVALID_PAYLOAD');
  return provider;
}

function normalizeClickIds(value) {
  if (value == null) return null;
  assertSafeRecord(value);
  const keys = Object.keys(value);
  if (keys.length > CLICK_IDS_MAX_KEYS) fail('INVALID_PAYLOAD');
  const normalized = {};
  for (const rawKey of keys) {
    const key = rawKey.trim().toLowerCase();
    if (!CLICK_ID_KEY_PATTERN.test(key) || Object.hasOwn(normalized, key)) fail('INVALID_PAYLOAD');
    const clickId = normalizeAttributionOptionalString(value[rawKey], 512);
    if (!clickId) fail('INVALID_PAYLOAD');
    normalized[key] = clickId;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeExtra(value) {
  if (value == null) return null;
  assertSafeRecord(value);
  const keys = Object.keys(value);
  if (keys.length > 30) fail('INVALID_PAYLOAD');
  const normalized = {};
  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || key.length > 200 || CONTROL_CHARACTER_PATTERN.test(key) || Object.hasOwn(normalized, key)) {
      fail('INVALID_PAYLOAD');
    }
    const extraValue = value[rawKey];
    if (extraValue !== null
      && typeof extraValue !== 'string'
      && typeof extraValue !== 'number'
      && typeof extraValue !== 'boolean') fail('INVALID_PAYLOAD');
    if (typeof extraValue === 'number' && !Number.isFinite(extraValue)) fail('INVALID_PAYLOAD');
    if (typeof extraValue === 'string'
      && (extraValue.length > 1000 || CONTROL_CHARACTER_PATTERN.test(extraValue))) fail('INVALID_PAYLOAD');
    normalized[key] = extraValue;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeUniversalAttribution(value) {
  if (value == null) return null;
  assertSafeRecord(value);
  for (const key of Object.keys(value)) {
    if (!UNIVERSAL_ATTRIBUTION_FIELDS.has(key)) fail('INVALID_PAYLOAD');
  }
  const normalized = {};
  for (const key of UNIVERSAL_ATTRIBUTION_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === 'provider') {
      const provider = normalizeProvider(value[key]);
      if (provider != null) normalized[key] = provider;
    } else if (key === 'click_ids') {
      const clickIds = normalizeClickIds(value[key]);
      if (clickIds) normalized[key] = clickIds;
    } else if (key === 'extra') {
      const extra = normalizeExtra(value[key]);
      if (extra) normalized[key] = extra;
    } else if (ATTRIBUTION_URL_FIELDS.has(key)) {
      const url = normalizeUrl(value[key]);
      if (url) normalized[key] = url;
    } else if (ATTRIBUTION_DATE_FIELDS.has(key)) {
      const date = normalizeIsoDate(value[key]);
      if (date) normalized[key] = date;
    } else {
      const text = normalizeAttributionOptionalString(
        value[key],
        key.endsWith('_id') ? 200 : 200,
        { lowercase: ATTRIBUTION_LABEL_FIELDS.has(key) },
      );
      if (text != null) normalized[key] = text;
    }
  }
  if (Buffer.byteLength(stableWebsiteJson(normalized), 'utf8') > ATTRIBUTION_MAX_BYTES) {
    fail('INVALID_PAYLOAD');
  }
  return Object.keys(normalized).length ? normalized : null;
}

function inferLegacyProvider(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (['facebook', 'instagram', 'meta'].includes(normalized)) return 'meta';
  if (normalized === 'google') return 'google';
  if (normalized === 'tiktok') return 'tiktok';
  if (['bing', 'microsoft'].includes(normalized)) return 'microsoft';
  if (normalized === 'linkedin') return 'linkedin';
  if (normalized === 'youtube') return 'youtube';
  return null;
}

function legacyAttribution(normalized) {
  const attribution = {};
  for (const field of LEGACY_ATTRIBUTION_FIELDS) {
    const key = field.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (normalized[key] != null) {
      attribution[field] = ['utm_source', 'utm_medium'].includes(field)
        ? normalized[key].toLowerCase()
        : normalized[key];
    }
  }
  if (normalized.utmSource != null) {
    attribution.source = normalized.utmSource.toLowerCase();
    const provider = inferLegacyProvider(normalized.utmSource);
    if (provider) attribution.provider = provider;
  }
  if (normalized.utmMedium != null) attribution.medium = normalized.utmMedium.toLowerCase();
  const clickIds = Object.fromEntries(
    ['fbclid', 'fbp', 'fbc']
      .filter((field) => normalized[field] != null)
      .map((field) => [field, normalized[field]]),
  );
  if (Object.keys(clickIds).length) attribution.click_ids = clickIds;
  return attribution;
}

function inferCanonicalProvider({ source = null, clickIds = null } = {}) {
  const providers = new Set();
  const clickProviderMap = {
    fbclid: 'meta',
    fbp: 'meta',
    fbc: 'meta',
    gclid: 'google',
    gbraid: 'google',
    wbraid: 'google',
    ttclid: 'tiktok',
    msclkid: 'microsoft',
  };
  for (const key of Object.keys(clickIds || {})) {
    if (clickProviderMap[key]) providers.add(clickProviderMap[key]);
  }
  const sourceProvider = inferLegacyProvider(source);
  if (sourceProvider) providers.add(sourceProvider);
  return providers.size === 1 ? [...providers][0] : null;
}

function canonicalizeAttribution(value) {
  if (!value || Object.keys(value).length === 0) return {};
  const canonical = {};
  const source = value.source || value.utm_source || null;
  const utmSource = value.utm_source || null;
  const medium = value.medium || value.utm_medium || null;
  const utmMedium = value.utm_medium || null;

  if (source) canonical.source = source;
  if (utmSource && utmSource !== source) canonical.utm_source = utmSource;
  if (medium) canonical.medium = medium;
  if (utmMedium && utmMedium !== medium) canonical.utm_medium = utmMedium;
  if (value.provider) canonical.provider = value.provider;

  for (const [key, item] of Object.entries(value)) {
    if (key === 'provider' || key === 'source' || key === 'utm_source'
      || key === 'medium' || key === 'utm_medium'
      || key === 'fbclid' || key === 'fbp' || key === 'fbc') continue;
    canonical[key] = item;
  }

  if (!canonical.provider) {
    const provider = inferCanonicalProvider({
      source: canonical.source || canonical.utm_source,
      clickIds: canonical.click_ids,
    });
    if (provider) canonical.provider = provider;
  }
  return canonical;
}

function mergeAttributions(legacy, explicit) {
  if (!legacy && !explicit) return null;
  const merged = { ...(legacy || {}) };
  for (const [key, value] of Object.entries(explicit || {})) {
    if (key === 'click_ids') {
      const mergedClickIds = { ...(merged.click_ids || {}) };
      for (const [clickKey, clickValue] of Object.entries(value)) {
        if (mergedClickIds[clickKey] != null && mergedClickIds[clickKey] !== clickValue) {
          fail('ATTRIBUTION_CONFLICT');
        }
        mergedClickIds[clickKey] = clickValue;
      }
      merged.click_ids = mergedClickIds;
      continue;
    }
    if (merged[key] != null && merged[key] !== value) fail('ATTRIBUTION_CONFLICT');
    merged[key] = value;
  }
  const canonical = canonicalizeAttribution(merged);
  if (Buffer.byteLength(stableWebsiteJson(canonical), 'utf8') > ATTRIBUTION_MAX_BYTES) {
    fail('INVALID_PAYLOAD');
  }
  return canonical;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableWebsiteJson(value) {
  return JSON.stringify(stableValue(value));
}

export function hashWebsitePayload(value) {
  return crypto.createHash('sha256').update(stableWebsiteJson(value), 'utf8').digest('hex');
}

export function websiteEventId({ externalLeadId, websiteSubmissionId }) {
  if (websiteSubmissionId) return `web:lead:${websiteSubmissionId}`;
  return `web:lead:supereducar:${externalLeadId}`;
}

export function technicalWebsiteLeadName(externalLeadId) {
  void externalLeadId;
  return 'Sem nome — site';
}

export function websiteIdempotencyKey(externalLeadId) {
  return `supereducar:${externalLeadId}`;
}

export function isValidWebsiteIdempotencyKey(value, externalLeadId) {
  return typeof value === 'string'
    && value.length <= 320
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && value === websiteIdempotencyKey(externalLeadId);
}

export function normalizeWebsiteLeadPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_PAYLOAD');
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_FIELDS.has(key)) fail('INVALID_PAYLOAD');
  }

  const externalLeadId = normalizeRequiredString(payload.external_lead_id, 'external_lead_id');
  const websiteSubmissionId = normalizeOptionalString(payload.website_submission_id, 'website_submission_id', 100)?.toLowerCase() || null;
  if (websiteSubmissionId && !UUID_PATTERN.test(websiteSubmissionId)) fail('INVALID_PAYLOAD');
  const interest = normalizeRequiredString(payload.interest, 'interest');
  const phone = normalizeRequiredString(payload.phone, 'phone', 60);
  const phoneNormalized = normalizeWhatsAppPhoneOrNull(phone);
  if (!phoneNormalized) fail('INVALID_PAYLOAD');
  const submittedAt = normalizeIsoDate(payload.submitted_at, { required: true });
  const name = normalizeOptionalString(payload.name, 'name');

  const normalized = {
    externalLeadId,
    websiteSubmissionId: websiteSubmissionId || null,
    interest,
    courseId: normalizeOptionalString(payload.course_id, 'course_id'),
    courseName: normalizeOptionalString(payload.course_name, 'course_name'),
    modality: normalizeOptionalString(payload.modality, 'modality'),
    name,
    email: normalizeOptionalString(payload.email, 'email', 320),
    phone,
    phoneNormalized,
    submittedAt,
    nameIsPlaceholder: name == null,
    nameSource: name == null ? 'TECHNICAL_PLACEHOLDER' : 'USER_PROVIDED',
  };
  if (normalized.email && !EMAIL_PATTERN.test(normalized.email)) fail('INVALID_PAYLOAD');

  for (const field of TEXT_FIELDS) {
    const key = field.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    normalized[key] = normalizeOptionalString(payload[field], field);
  }
  for (const field of URL_FIELDS) {
    const key = field.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    normalized[key] = normalizeUrl(payload[field]);
  }
  normalized.consentAt = normalizeIsoDate(payload.consent_at);

  const attribution = mergeAttributions(
    legacyAttribution(normalized),
    normalizeUniversalAttribution(payload.attribution),
  );
  const hashInput = {
    external_lead_id: normalized.externalLeadId,
    website_submission_id: normalized.websiteSubmissionId,
    interest: normalized.interest,
    course_id: normalized.courseId,
    course_name: normalized.courseName,
    modality: normalized.modality,
    name: normalized.name,
    email: normalized.email,
    phone: normalized.phoneNormalized,
    submitted_at: normalized.submittedAt,
    attribution,
  };
  return {
    ...normalized,
    attribution,
    websiteEventId: websiteEventId({
      externalLeadId: normalized.externalLeadId,
      websiteSubmissionId: normalized.websiteSubmissionId,
    }),
    payloadHash: hashWebsitePayload(hashInput),
    hashInput,
  };
}

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return entry ? String(entry[1] ?? '') : '';
}

function constantTimeEqual(first, second) {
  const a = Buffer.from(String(first));
  const b = Buffer.from(String(second));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function websiteIngestConfig(env = process.env) {
  const clockSkewSeconds = Number.parseInt(
    String(env.SUPEREDUCAR_WEBSITE_INGEST_CLOCK_SKEW_SECONDS || WEBSITE_DEFAULT_CLOCK_SKEW_SECONDS),
    10,
  );
  const secret = String(env.SUPEREDUCAR_WEBSITE_INGEST_HMAC_SECRET || '').trim();
  const tenantId = String(env.SUPEREDUCAR_WEBSITE_INGEST_TENANT_ID || '').trim();
  return {
    enabled: String(env.SUPEREDUCAR_WEBSITE_INGEST_ENABLED || '').trim().toLowerCase() === 'true',
    secret,
    tenantId,
    clockSkewSeconds: Number.isInteger(clockSkewSeconds) && clockSkewSeconds > 0
      ? Math.min(clockSkewSeconds, 3600)
      : WEBSITE_DEFAULT_CLOCK_SKEW_SECONDS,
    configured: Boolean(secret && Buffer.byteLength(secret, 'utf8') >= 32 && tenantId),
  };
}

export function websiteSignature({ secret, timestamp, nonce, rawBody }) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  return `sha256=${crypto.createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n`)
    .update(body)
    .digest('hex')}`;
}

export function authenticateWebsiteRequest({ headers, rawBody, env = process.env, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const config = websiteIngestConfig(env);
  if (!config.configured) return { ok: false, status: 503, code: 'WEBSITE_INGEST_NOT_CONFIGURED' };
  if (headerValue(headers, 'X-SE-Integration') !== WEBSITE_INTEGRATION) {
    return { ok: false, status: 401, code: 'INVALID_INTEGRATION' };
  }
  const timestamp = headerValue(headers, 'X-SE-Timestamp');
  const nonce = headerValue(headers, 'X-SE-Nonce');
  const signature = headerValue(headers, 'X-SE-Signature');
  if (!/^\d{1,12}$/.test(timestamp) || !nonce || nonce.length > 200 || !signature) {
    return { ok: false, status: 401, code: 'INVALID_SIGNATURE' };
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > config.clockSkewSeconds) {
    return { ok: false, status: 401, code: 'TIMESTAMP_OUT_OF_RANGE' };
  }
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, status: 401, code: 'INVALID_SIGNATURE' };
  }
  const expected = websiteSignature({ secret: config.secret, timestamp, nonce, rawBody });
  if (!constantTimeEqual(signature.toLowerCase(), expected)) {
    return { ok: false, status: 401, code: 'INVALID_SIGNATURE' };
  }
  return { ok: true, timestamp: timestampNumber, nonce };
}

export function createWebsiteRateLimiter({
  limit = WEBSITE_RATE_LIMIT,
  windowMs = WEBSITE_RATE_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const windows = new Map();
  return {
    allow(key = WEBSITE_INTEGRATION) {
      const currentTime = now();
      const previous = windows.get(key);
      if (!previous || currentTime - previous.startedAt >= windowMs) {
        windows.set(key, { startedAt: currentTime, count: 1 });
        return { allowed: true, retryAfter: 0 };
      }
      if (previous.count >= limit) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((windowMs - (currentTime - previous.startedAt)) / 1000)),
        };
      }
      previous.count += 1;
      return { allowed: true, retryAfter: 0 };
    },
    clear() {
      windows.clear();
    },
  };
}

export function decideWebsiteSubmission(existing, incoming) {
  if (!existing) return { code: 'CREATED', created: true };
  if (existing.payload_hash === incoming.payloadHash) {
    return {
      code: 'IDEMPOTENT_REPLAY',
      created: false,
      leadId: existing.lead_id,
      websiteEventId: existing.website_event_id,
    };
  }
  return { code: 'EXTERNAL_ID_CONFLICT', created: false };
}

export function sanitizeWebsiteExternalId(externalLeadId) {
  return crypto.createHash('sha256').update(String(externalLeadId), 'utf8').digest('hex').slice(0, 16);
}
