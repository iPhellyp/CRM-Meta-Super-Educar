const BRAZILIAN_AREA_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export const PHONE_CLASSIFICATIONS = Object.freeze({
  BR_MOBILE_CANONICAL: 'BR_MOBILE_CANONICAL',
  BR_MOBILE_LEGACY: 'BR_MOBILE_LEGACY',
  BR_FIXED: 'BR_FIXED',
  UNKNOWN: 'UNKNOWN',
  VALID: 'VALID',
  PHONE_EMPTY: 'PHONE_EMPTY',
  PHONE_INVALID: 'PHONE_INVALID',
  LID_UNRESOLVED: 'LID_UNRESOLVED',
});

function safePhoneText(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

export function getBrazilianPhoneIdentity(value, { confirmedMobile = false } = {}) {
  const raw = safePhoneText(value);
  if (!raw) {
    return {
      original: raw,
      countryCode: null,
      areaCode: null,
      subscriber: null,
      canonicalE164: null,
      aliases: [],
      classification: PHONE_CLASSIFICATIONS.UNKNOWN,
      status: PHONE_CLASSIFICATIONS.PHONE_EMPTY,
      phoneNormalized: null,
    };
  }
  if (/@lid$/i.test(raw)) {
    return {
      original: raw,
      countryCode: null,
      areaCode: null,
      subscriber: null,
      canonicalE164: null,
      aliases: [],
      classification: PHONE_CLASSIFICATIONS.UNKNOWN,
      status: PHONE_CLASSIFICATIONS.LID_UNRESOLVED,
      phoneNormalized: null,
    };
  }
  if (/^\+\s*(?!55)/.test(raw)) {
    return {
      original: raw,
      countryCode: null,
      areaCode: null,
      subscriber: null,
      canonicalE164: null,
      aliases: [],
      classification: PHONE_CLASSIFICATIONS.UNKNOWN,
      status: PHONE_CLASSIFICATIONS.PHONE_INVALID,
      phoneNormalized: null,
    };
  }

  const withoutJid = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '');
  if (withoutJid.includes('@')) {
    return { status: PHONE_CLASSIFICATIONS.PHONE_INVALID, phoneNormalized: null };
  }
  let digits = withoutJid.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) {
    return {
      original: raw,
      countryCode: null,
      areaCode: null,
      subscriber: null,
      canonicalE164: null,
      aliases: [],
      classification: PHONE_CLASSIFICATIONS.UNKNOWN,
      status: PHONE_CLASSIFICATIONS.PHONE_INVALID,
      phoneNormalized: null,
    };
  }

  const areaCode = Number(digits.slice(2, 4));
  const localNumber = digits.slice(4);
  if (!BRAZILIAN_AREA_CODES.has(areaCode) || !/^\d{8,9}$/.test(localNumber) || /^0+$/.test(localNumber)) {
    return {
      original: raw,
      countryCode: 55,
      areaCode,
      subscriber: localNumber,
      canonicalE164: null,
      aliases: [],
      classification: PHONE_CLASSIFICATIONS.UNKNOWN,
      status: PHONE_CLASSIFICATIONS.PHONE_INVALID,
      phoneNormalized: null,
    };
  }

  const legacyMobile = localNumber.length === 8 && confirmedMobile;
  const canonicalE164 = legacyMobile
    ? `55${digits.slice(2, 4)}9${localNumber}`
    : digits;
  const canonicalMobile = localNumber.length === 9 && localNumber.startsWith('9');
  const classification = canonicalMobile
    ? PHONE_CLASSIFICATIONS.BR_MOBILE_CANONICAL
    : legacyMobile
      ? PHONE_CLASSIFICATIONS.BR_MOBILE_LEGACY
      : PHONE_CLASSIFICATIONS.BR_FIXED;
  const legacyE164 = canonicalMobile
    ? `55${digits.slice(2, 4)}${localNumber.slice(1)}`
    : digits;
  const legacyLocal = `${digits.slice(2, 4)}${canonicalMobile ? localNumber.slice(1) : localNumber}`;
  const canonicalLocal = `${digits.slice(2, 4)}${canonicalMobile ? localNumber : `9${localNumber}`}`;
  const aliases = classification === PHONE_CLASSIFICATIONS.BR_FIXED
    ? [digits, `${digits.slice(2)}`]
    : [
      digits,
      canonicalE164,
      legacyE164,
      legacyLocal,
      canonicalLocal,
    ].filter((alias, index, all) => all.indexOf(alias) === index);
  return {
    original: raw,
    countryCode: 55,
    areaCode,
    subscriber: localNumber,
    canonicalE164,
    aliases,
    classification,
    status: PHONE_CLASSIFICATIONS.VALID,
    phoneNormalized: canonicalE164,
  };
}

export function classifyBrazilianPhone(value, options = {}) {
  return getBrazilianPhoneIdentity(value, options);
}

export function normalizeBrazilianPhone(value) {
  return classifyBrazilianPhone(value).phoneNormalized || '';
}

export function normalizeConfirmedWhatsAppPhone(value) {
  return getBrazilianPhoneIdentity(value, { confirmedMobile: true }).canonicalE164 || '';
}

export function normalizeWhatsAppPhone(value) {
  return normalizeBrazilianPhone(value);
}

export function normalizeWhatsAppPhoneOrNull(value) {
  return normalizeBrazilianPhone(value) || null;
}

export function selectBestLeadPhone(lead = {}) {
  const candidates = [
    lead.phone_normalized,
    lead.whatsapp_normalized,
    lead.phone,
    lead.whatsapp,
  ];
  let lidFound = false;
  for (const candidate of candidates) {
    const classified = classifyBrazilianPhone(candidate);
    if (classified.status === PHONE_CLASSIFICATIONS.VALID) {
      return {
        status: classified.status,
        phoneNormalized: classified.phoneNormalized,
      };
    }
    if (classified.status === PHONE_CLASSIFICATIONS.LID_UNRESOLVED) lidFound = true;
  }

  const remoteJid = safePhoneText(lead.remote_jid);
  if (/@(s\.whatsapp\.net|c\.us)$/i.test(remoteJid)) {
    return classifyBrazilianPhone(remoteJid);
  }
  if (/@lid$/i.test(remoteJid)) lidFound = true;
  return {
    status: lidFound
      ? PHONE_CLASSIFICATIONS.LID_UNRESOLVED
      : candidates.some((candidate) => safePhoneText(candidate))
        ? PHONE_CLASSIFICATIONS.PHONE_INVALID
        : PHONE_CLASSIFICATIONS.PHONE_EMPTY,
    phoneNormalized: null,
  };
}

export function getWhatsAppUrl(value, message = '') {
  const normalizedPhone = normalizeBrazilianPhone(value);
  if (!normalizedPhone) return '';
  const url = new URL(`https://wa.me/${normalizedPhone}`);
  if (String(message || '').trim()) url.searchParams.set('text', String(message).trim());
  return url.toString();
}
