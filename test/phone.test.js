import test from 'node:test';
import assert from 'node:assert/strict';
import { getWhatsAppUrl, normalizeWhatsAppPhone } from '../src/phone.js';

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

test('rejeita formatos de telefone não reconhecidos', () => {
  for (const phone of ['', null, 'texto sem número', '99999-0000', '389999', '550000']) {
    assert.equal(normalizeWhatsAppPhone(phone), '');
  }
});

test('gera URL somente para telefone válido', () => {
  assert.equal(getWhatsAppUrl('(38) 99999-0000'), 'https://wa.me/5538999990000');
  assert.equal(getWhatsAppUrl('telefone vazio'), '');
});
