import { createHash } from 'node:crypto';

export const WA2_DAILY_RECONCILIATION_TIME_ZONE = 'America/Sao_Paulo';
export const WA2_DAILY_RECONCILIATION_BACKOFF_MS = 15 * 60_000;

const TRANSIENT_CODES = new Set([
  'WA2_HTTP_ERROR',
  'WA2_IDENTITY_REBUILD_FAILED',
  'WA2_IDENTITY_REBUILD_TIMEOUT',
  'WA2_TEMPORARY_FAILURE',
  'WA2_TIMEOUT',
  'WA2_UNAVAILABLE',
]);

function dateParts(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WA2_DAILY_RECONCILIATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).reduce((parts, part) => {
    if (part.type !== 'literal') parts[part.type] = part.value;
    return parts;
  }, {});
}

export function wa2DailyLocalDate(value = new Date()) {
  const parts = dateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isWa2DailyReconciliationEnabled(env = process.env) {
  return String(env.WA2_DAILY_RECONCILIATION_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

export function isTransientWa2DailyError(error) {
  const code = String(error?.code || '').trim();
  const status = Number(error?.status);
  if (code === 'WA2_HTTP_ERROR') {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (TRANSIENT_CODES.has(code)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function describeWa2DailyError(error) {
  const name = String(error?.name || 'Error').slice(0, 80);
  const code = String(error?.code || 'WA2_DAILY_RECONCILIATION_FAILED').slice(0, 100);
  const message = String(error?.message || 'Falha não especificada')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
  const status = Number.isInteger(Number(error?.status)) ? Number(error.status) : null;
  const remoteCode = error?.remoteCode == null
    ? null
    : String(error.remoteCode).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
  const fingerprint = createHash('sha256')
    .update(`${name}:${code}:${message}:${status ?? ''}:${remoteCode ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return {
    name,
    code,
    message,
    status,
    remoteCode,
    fingerprint,
    transient: isTransientWa2DailyError(error),
  };
}

export function createWa2DailyScheduleState({
  now = () => Date.now(),
  localDate = (value) => wa2DailyLocalDate(value),
  backoffMs = WA2_DAILY_RECONCILIATION_BACKOFF_MS,
} = {}) {
  let inFlight = null;
  let backoffUntil = 0;
  let blockedDate = null;

  return {
    run(task) {
      if (typeof task !== 'function') throw new TypeError('Tarefa do scheduler é obrigatória');
      const currentTime = now();
      const currentDate = localDate(new Date(currentTime));
      if (inFlight) return inFlight;
      if (blockedDate === currentDate || backoffUntil > currentTime) return null;

      const promise = Promise.resolve()
        .then(task)
        .catch((error) => {
          if (isTransientWa2DailyError(error)) {
            backoffUntil = now() + backoffMs;
          } else {
            blockedDate = localDate(new Date(now()));
          }
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = promise;
      return promise;
    },
    getState() {
      return {
        inFlight: Boolean(inFlight),
        backoffUntil,
        blockedDate,
      };
    },
  };
}
