import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const loggingSource = source.slice(
  source.indexOf('function setupWhatsAppLogging'),
  source.indexOf('function setupActionDisclosures'),
);

test('ação principal do WhatsApp registra sem bloquear o link direto', () => {
  assert.doesNotMatch(source, /window\.open\s*\(/);
  assert.doesNotMatch(source, /about:blank/);
  assert.doesNotMatch(source, /setupWhatsAppActions|setWhatsAppLoading|data-whatsapp-form/);
  assert.doesNotMatch(source, /Abrindo (?:o )?WhatsApp/);
  assert.match(source, /querySelectorAll\('\[data-whatsapp-link\]'\)/);
  assert.match(source, /navigator\.sendBeacon\?\.\(url, payload\)/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /keepalive: true/);
  assert.match(source, /\.catch\(\(\) => \{\}\)/);
});

test('logging do WhatsApp não aguarda resposta nem altera o link principal', () => {
  assert.match(loggingSource, /link\.addEventListener\('click', \(\) =>/);
  assert.doesNotMatch(loggingSource, /await navigator\.sendBeacon|await fetch/);
  assert.doesNotMatch(loggingSource, /preventDefault|\.disabled\s*=|data-whatsapp-submit/);
});

test('copiar telefone usa Clipboard API e fallback local', () => {
  assert.match(source, /function setupCopyPhoneActions/);
  assert.match(source, /navigator\.clipboard\.writeText\(phone\)/);
  assert.match(source, /document\.execCommand\('copy'\)/);
});
