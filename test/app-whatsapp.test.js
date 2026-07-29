import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('ação principal do WhatsApp preserva navegação HTML nativa', () => {
  assert.doesNotMatch(source, /window\.open\s*\(/);
  assert.doesNotMatch(source, /about:blank/);
  assert.doesNotMatch(source, /fetch\s*\(\s*form\.action/);
  const whatsappSetup = source.match(
    /function setupWhatsAppActions\(\) \{[\s\S]*?\n\}\n\nfunction setupActionDisclosures/,
  )?.[0] || '';
  assert.doesNotMatch(whatsappSetup, /preventDefault\s*\(/);
  assert.match(whatsappSetup, /Abrindo o WhatsApp…/);
});

test('duplo clique é contido desabilitando o submit de forma síncrona', () => {
  assert.match(source, /if \(button\?\.disabled\) return;/);
  assert.match(source, /setWhatsAppLoading\(form, true\)/);
  assert.match(source, /if \(button\) button\.disabled = loading/);
});

test('copiar telefone usa Clipboard API e fallback local', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(phone\)/);
  assert.match(source, /document\.execCommand\('copy'\)/);
});
