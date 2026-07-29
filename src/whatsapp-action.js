const JSON_CACHE_CONTROL = 'private, no-store, max-age=0';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isStrictWhatsAppUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://wa.me/')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'wa.me' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '';
  } catch {
    return false;
  }
}

function acceptsJson(req) {
  return String(req.get('accept') || '')
    .split(',')
    .some((value) => value.trim().toLowerCase().startsWith('application/json'));
}

function sendJson(res, status, payload) {
  return res
    .status(status)
    .set('Cache-Control', JSON_CACHE_CONTROL)
    .json(payload);
}

function sendError(req, res, status, code, message, htmlMessage) {
  if (acceptsJson(req)) {
    return sendJson(res, status, {
      ok: false,
      error: { code, message },
    });
  }
  return res.status(status).send(htmlMessage);
}

export function createWhatsAppActionHandler({
  getLeadById,
  getTenantWhatsAppMessage,
  getWhatsAppUrl,
  recordWhatsAppOpened,
  selectBestLeadPhone,
}) {
  return async function whatsappActionHandler(req, res) {
    const leadId = String(req.params.id || '');
    if (!UUID_PATTERN.test(leadId)) {
      return sendError(
        req,
        res,
        404,
        'LEAD_NOT_FOUND',
        'Lead não encontrado.',
        'Lead inválido.',
      );
    }

    try {
      const [lead, template] = await Promise.all([
        getLeadById(leadId),
        getTenantWhatsAppMessage(),
      ]);
      if (!lead) {
        return sendError(
          req,
          res,
          404,
          'LEAD_NOT_FOUND',
          'Lead não encontrado.',
          'Lead não encontrado.',
        );
      }

      const phone = selectBestLeadPhone(lead);
      if (!phone.phoneNormalized) {
        return sendError(
          req,
          res,
          422,
          'PHONE_INVALID',
          'O telefone deste lead é inválido.',
          'Telefone inválido.',
        );
      }

      const message = template.replaceAll('{{nome}}', String(lead.name || '').trim());
      const redirectUrl = getWhatsAppUrl(phone.phoneNormalized, message);
      if (!isStrictWhatsAppUrl(redirectUrl)) {
        throw new Error('URL do WhatsApp inválida');
      }
      await recordWhatsAppOpened(lead.id, req.user.sub);

      if (acceptsJson(req)) {
        return sendJson(res, 200, { ok: true, redirectUrl });
      }
      return res.redirect(303, redirectUrl);
    } catch {
      return sendError(
        req,
        res,
        503,
        'WHATSAPP_UNAVAILABLE',
        'Não foi possível abrir o WhatsApp agora. Tente novamente.',
        'Não foi possível abrir o WhatsApp.',
      );
    }
  };
}
