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

export function classifyBrazilianPhone(value) {
  const raw = safePhoneText(value);
  if (!raw) {
    return { status: PHONE_CLASSIFICATIONS.PHONE_EMPTY, phoneNormalized: null };
  }
  if (/@lid$/i.test(raw)) {
    return { status: PHONE_CLASSIFICATIONS.LID_UNRESOLVED, phoneNormalized: null };
  }

  const withoutJid = raw.replace(/@(s\.whatsapp\.net|c\.us)$/i, '');
  if (withoutJid.includes('@')) {
    return { status: PHONE_CLASSIFICATIONS.PHONE_INVALID, phoneNormalized: null };
  }
  let digits = withoutJid.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) {
    return { status: PHONE_CLASSIFICATIONS.PHONE_INVALID, phoneNormalized: null };
  }

  const areaCode = Number(digits.slice(2, 4));
  const localNumber = digits.slice(4);
  if (
    !BRAZILIAN_AREA_CODES.has(areaCode) ||
    !/^\d{8,9}$/.test(localNumber) ||
    /^0+$/.test(localNumber)
  ) {
    return { status: PHONE_CLASSIFICATIONS.PHONE_INVALID, phoneNormalized: null };
  }
  return { status: PHONE_CLASSIFICATIONS.VALID, phoneNormalized: digits };
}

export function normalizeBrazilianPhone(value) {
  return classifyBrazilianPhone(value).phoneNormalized || '';
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
    if (classified.status === PHONE_CLASSIFICATIONS.VALID) return classified;
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
