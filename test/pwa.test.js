import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dashboardView } from '../src/views.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const worker = read('public/service-worker.js');
const app = read('public/app.js');
const server = read('src/server.js');

test('manifest é instalável, pt-BR e não contém dados privados', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.name, 'CRM Meta Super Educar');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'any');
  assert.equal(manifest.lang, 'pt-BR');
  assert.equal(manifest.icons.length, 3);
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), [
    '192x192',
    '512x512',
    '512x512',
  ]);
  for (const icon of manifest.icons) {
    assert.equal(fs.existsSync(path.join(root, 'public', icon.src)), true);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /token|secret|lead_id|phone/i);
});

test('service worker guarda somente assets públicos permitidos', () => {
  assert.match(worker, /const PUBLIC_ASSETS = \[/);
  for (const asset of [
    '/app.css?v=4',
    '/app.js?v=4',
    '/manifest.webmanifest',
    '/offline.html',
    '/icons/app-icon-192.png',
    '/icons/app-icon-512.png',
    '/icons/app-icon-maskable-512.png',
    '/icons/app-icon.svg',
    '/icons/app-icon-maskable.svg',
  ]) {
    assert.match(worker, new RegExp(asset.replace(/[.?/]/g, '\\$&')));
  }
  assert.doesNotMatch(worker, /cache\.put|staleWhileRevalidate|networkFirst/i);
  assert.doesNotMatch(worker, /['"`]\/(leads|events|operations|meta|wa2|login|logout)/);
  assert.match(worker, /if \(request\.method !== 'GET'\) return/);
  assert.match(worker, /request\.mode === 'navigate'[\s\S]*fetch\(request\)\.catch\(\(\) => caches\.match\('\/offline\.html'\)\)/);
});

test('offline é genérico e não contém conteúdo administrativo', () => {
  const offline = read('public/offline.html');
  assert.match(offline, /Conexão necessária/);
  assert.match(offline, /Tentar novamente/);
  assert.match(offline, /não armazena leads ou conteúdo administrativo/);
  assert.doesNotMatch(offline, /telefone|campanha|histórico|QR|nome do usuário/i);
});

test('telas dinâmicas e logout recebem política de descarte', () => {
  assert.match(server, /app\.use\(\(_req, res, next\) => \{\s*noStore\(res\)/);
  assert.match(server, /'Cache-Control': 'private, no-store, max-age=0'/);
  assert.match(server, /service-worker\.js'[\s\S]*'Cache-Control': 'no-cache, no-store, must-revalidate'/);
  assert.match(server, /app\.post\('\/logout'[\s\S]*Clear-Site-Data', '"cache", "storage"'/);
});

test('shell oferece instalação, atualização consentida e estado de conexão', () => {
  const html = dashboardView({
    leads: [],
    counts: {},
    metaStatus: {
      configured: false,
      graphVersion: 'v25.0',
      testMode: true,
      missing: [],
    },
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 0 },
    csrfToken: 'csrf',
  });
  assert.match(html, /rel="manifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /data-pwa-install-panel hidden role="status"/);
  assert.match(html, /data-pwa-update hidden role="status"/);
  assert.match(html, /data-connection-status hidden role="status"/);
  assert.match(html, /data-pwa-logout/);
});

test('cliente não força atualização e limpa somente caches próprios', () => {
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /data-pwa-install-dismiss/);
  assert.match(app, /form\[data-dirty="true"\]/);
  assert.match(app, /waitingWorker\?\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.doesNotMatch(app, /skipWaiting\(\)/);
  assert.match(app, /key\.startsWith\(PWA_CACHE_PREFIX\)/);
  assert.doesNotMatch(app, /localStorage\.(clear|setItem)/);
  assert.match(app, /CLEAR_APP_CACHES/);
});
