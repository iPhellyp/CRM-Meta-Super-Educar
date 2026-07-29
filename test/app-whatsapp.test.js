import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('ação principal do WhatsApp preserva navegação HTML nativa', () => {
  assert.doesNotMatch(source, /window\.open\s*\(/);
  assert.doesNotMatch(source, /about:blank/);
  assert.doesNotMatch(source, /fetch\s*\(\s*form\.action/);
  assert.doesNotMatch(source, /setupWhatsAppActions|setWhatsAppLoading/);
  assert.doesNotMatch(source, /Abrindo (?:o )?WhatsApp/);
  assert.match(source, /form\.matches\('\[data-whatsapp-form\]'\)\) continue/);
});

test('JavaScript não escuta submit nem desabilita o botão principal', () => {
  assert.doesNotMatch(source, /addEventListener\('submit'[\s\S]*data-whatsapp-submit/);
  assert.doesNotMatch(source, /querySelector\('\[data-whatsapp-submit\]'\)/);
});

test('copiar telefone usa Clipboard API e fallback local', () => {
  assert.match(source, /function setupCopyPhoneActions/);
  assert.match(source, /navigator\.clipboard\.writeText\(phone\)/);
  assert.match(source, /document\.execCommand\('copy'\)/);
});
