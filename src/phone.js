export function normalizeWhatsAppPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^[1-9]\d{9,10}$/.test(digits)) return `55${digits}`;
  if (/^55[1-9]\d{9,10}$/.test(digits)) return digits;
  return '';
}

export function normalizeWhatsAppPhoneOrNull(value) {
  return normalizeWhatsAppPhone(value) || null;
}

export function getWhatsAppUrl(value) {
  const normalizedPhone = normalizeWhatsAppPhone(value);
  return normalizedPhone ? `https://wa.me/${normalizedPhone}` : '';
}
