import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHONE_CLASSIFICATIONS,
  classifyBrazilianPhone,
  getBrazilianPhoneIdentity,
  getWhatsAppUrl,
  normalizeBrazilianPhone,
  normalizeConfirmedWhatsAppPhone,
  normalizeWhatsAppPhone,
  normalizeWhatsAppPhoneOrNull,
  selectBestLeadPhone,
} from '../src/phone.js';

test('normaliza telefones nacionais válidos sem alterar o número local', () => {
  assert.equal(normalizeWhatsAppPhone('(38) 3333-0000'), '553833330000');
  assert.equal(normalizeWhatsAppPhone('(38) 99999-0000'), '5538999990000');
  assert.equal(normalizeWhatsAppPhone('38999990000'), '5538999990000');
});

test('preserva telefones válidos que já contêm DDI 55', () => {
  assert.equal(normalizeWhatsAppPhone('553833330000'), '553833330000');
  assert.equal(normalizeWhatsAppPhone('+55 38 99999-0000'), '5538999990000');
});

test('não adiciona nem remove o nono dígito', () => {
  assert.equal(normalizeWhatsAppPhone('3833330000'), '553833330000');
  assert.equal(normalizeWhatsAppPhone('38999990000'), '5538999990000');
});

test('normaliza alias móvel brasileiro confirmado no ponto correto', () => {
  const identity = getBrazilianPhoneIdentity('553888515846', { confirmedMobile: true });
  assert.equal(identity.canonicalE164, '5538988515846');
  assert.deepEqual(identity.aliases, [
    '553888515846',
    '5538988515846',
    '3888515846',
    '38988515846',
  ]);
  assert.equal(identity.classification, PHONE_CLASSIFICATIONS.BR_MOBILE_LEGACY);
  assert.equal(normalizeConfirmedWhatsAppPhone('553888515846'), '5538988515846');
  assert.equal(
    getBrazilianPhoneIdentity('5538988515846', { confirmedMobile: true }).canonicalE164,
    '5538988515846',
  );
});

test('não transforma fixo, estrangeiro ou número diferente em móvel equivalente', () => {
  assert.equal(
    getBrazilianPhoneIdentity('553833330000').classification,
    PHONE_CLASSIFICATIONS.BR_FIXED,
  );
  assert.equal(normalizeConfirmedWhatsAppPhone('+1 202 555 0100'), '');
  assert.notEqual(
    getBrazilianPhoneIdentity('553888515847', { confirmedMobile: true }).canonicalE164,
    '5538988515846',
  );
});

test('rejeita formatos de telefone não reconhecidos', () => {
  for (const phone of ['', null, 'texto sem número', '99999-0000', '389999', '550000']) {
    assert.equal(normalizeWhatsAppPhone(phone), '');
  }
});

test('gera URL somente para telefone válido', () => {
  assert.equal(getWhatsAppUrl('(38) 99999-0000'), 'https://wa.me/5538999990000');
  assert.equal(getWhatsAppUrl('telefone vazio'), '');
});

test('retorna null para persistência quando telefone é inválido', () => {
  assert.equal(normalizeWhatsAppPhoneOrNull('(38) 99999-0000'), '5538999990000');
  assert.equal(normalizeWhatsAppPhoneOrNull('telefone inválido'), null);
});

test('normaliza os formatos reais exigidos pela reconciliação', () => {
  for (const input of [
    '(38) 99114-2298',
    '38 99114-2298',
    '38991142298',
    '5538991142298',
    '+55 38 99114-2298',
    '5538991142298@s.whatsapp.net',
    '5538991142298@c.us',
  ]) {
    assert.equal(normalizeBrazilianPhone(input), '5538991142298');
  }
});

test('separa telefone vazio, inválido e LID não resolvido', () => {
  assert.equal(
    classifyBrazilianPhone('').status,
    PHONE_CLASSIFICATIONS.PHONE_EMPTY,
  );
  assert.equal(
    classifyBrazilianPhone('12345678901234567890').status,
    PHONE_CLASSIFICATIONS.PHONE_INVALID,
  );
  assert.equal(
    classifyBrazilianPhone('qualquer-coisa@lid').status,
    PHONE_CLASSIFICATIONS.LID_UNRESOLVED,
  );
});

test('seleciona o melhor campo sem usar LID como telefone', () => {
  assert.deepEqual(selectBestLeadPhone({
    phone_normalized: null,
    whatsapp_normalized: '5538991142298',
    phone: 'inválido',
    remote_jid: '123@lid',
  }), {
    status: PHONE_CLASSIFICATIONS.VALID,
    phoneNormalized: '5538991142298',
  });
  assert.equal(
    selectBestLeadPhone({ remote_jid: '123@lid' }).status,
    PHONE_CLASSIFICATIONS.LID_UNRESOLVED,
  );
});

test('gera URL normalizada com mensagem codificada', () => {
  const url = new URL(getWhatsAppUrl('(38) 99114-2298', 'Olá, Ana! Tudo bem?'));
  assert.equal(url.origin + url.pathname, 'https://wa.me/5538991142298');
  assert.equal(url.searchParams.get('text'), 'Olá, Ana! Tudo bem?');
});
