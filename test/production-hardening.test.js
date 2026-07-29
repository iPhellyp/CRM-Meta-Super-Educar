import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  dashboardView,
  historicalOperationsView,
  loginView,
} from '../src/views.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const bytes = (file) => fs.statSync(path.join(root, file)).size;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function lead(index) {
  return {
    id: `lead-${index}`,
    name: `Lead ${index} com nome suficientemente longo para testar quebra`,
    phone: `553899999${String(index).padStart(4, '0')}`,
    email: `lead${index}@example.test`,
    course: 'Pós-graduação em Educação e Gestão Escolar',
    city: 'São Paulo',
    source: 'META_INSTANT_FORM',
    stage: 'NEW',
    received_at: '2026-07-29T10:31:00.000Z',
    meta_lead_id: `meta-${index}`,
    meta_connection_name: 'Meta Super Educar',
    meta_page_name: 'Super Educar',
    meta_form_name: 'Captação',
  };
}

test('budgets mantêm shell leve e HTML de 100 leads controlado', () => {
  assert.ok(bytes('public/app.css') < 100 * 1024, 'CSS deve permanecer abaixo de 100 KiB');
  assert.ok(bytes('public/app.js') < 100 * 1024, 'JavaScript deve permanecer abaixo de 100 KiB');
  assert.ok(bytes('public/service-worker.js') < 20 * 1024, 'Service worker deve ser pequeno');

  const html = dashboardView({
    leads: Array.from({ length: 100 }, (_, index) => lead(index + 1)),
    counts: {},
    metaStatus: {
      configured: true,
      graphVersion: 'v25.0',
      testMode: false,
      missing: [],
    },
    filters: {},
    pagination: { page: 1, totalPages: 1, total: 100, hasNext: false },
    csrfToken: 'csrf',
  });
  assert.ok(Buffer.byteLength(html) < 2_500_000, 'HTML com 100 leads deve ficar abaixo de 2,5 MiB');
  assert.equal((html.match(/class="lead-card"/g) || []).length, 100);
  assert.equal((html.match(/<tr>/g) || []).length >= 101, true);
});

test('SheetJS permanece exclusivamente no servidor', () => {
  const publicSource = walk(path.join(root, 'public'))
    .filter((file) => /\.(?:js|html|css|webmanifest|svg)$/i.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicSource, /from ['"]xlsx['"]|require\(['"]xlsx['"]\)|sheetjs/i);
  assert.match(read('src/lead-file-import.js'), /import \* as XLSX from 'xlsx'/);
  assert.doesNotMatch(read('src/views.js'), /<script[^>]+(?:xlsx|sheetjs)/i);
});

test('public não contém uploads, credenciais ou chaves privadas', () => {
  const publicFiles = walk(path.join(root, 'public'));
  assert.equal(
    publicFiles.some((file) => /\.(?:csv|xlsx|xls)$/i.test(file)),
    false,
  );
  const publicText = publicFiles
    .filter((file) => !/\.(?:png|jpg|jpeg|webp|gif|ico)$/i.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicText, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
  assert.doesNotMatch(publicText, /META_(?:APP_SECRET|CAPI_ACCESS_TOKEN|PAGE_ACCESS_TOKEN)\s*=/);
  assert.doesNotMatch(publicText, /WA2_INTERNAL_API_SECRET\s*=/);
});

test('middleware de segurança, compressão e no-store antecede rotas privadas', () => {
  const server = read('src/server.js');
  const helmet = server.indexOf('app.use(helmet())');
  const compression = server.indexOf('app.use(compression())');
  const noStore = server.indexOf('app.use((_req, res, next)');
  const auth = server.indexOf('app.use(requireAuth)');
  const dashboard = server.indexOf("app.get('/',");
  assert.ok(helmet >= 0 && compression > helmet);
  assert.ok(noStore > compression && auth > noStore && dashboard > auth);
  assert.match(server, /express\.urlencoded\(\{ extended: false, limit: '32kb' \}\)/);
  assert.match(server, /express\.json\(\{\s*limit: '256kb'/);
});

test('views críticas preservam semântica, CSRF e progressive enhancement', () => {
  const login = loginView('', 'csrf');
  assert.match(login, /lang="pt-BR"/);
  assert.match(login, /<main id="main-content">/);
  assert.match(login, /<label>E-mail<input/);
  assert.match(login, /<label>Senha<input/);
  assert.match(login, /name="_csrf"/);

  const operations = historicalOperationsView({
    operations: {
      cursor: null,
      imports: [],
      fileImports: [],
      reconciliations: [],
      conflicts: [],
      confirmations: [],
    },
    instances: [],
    metaForms: [],
    csrfToken: 'csrf',
  });
  assert.match(operations, /<details class="technical-details">|Nenhum formulário disponível/);
  assert.match(operations, /role="status"/);
  assert.match(operations, /data-pwa-update hidden role="status"/);
});

test('inicializadores do cliente são registrados uma única vez', () => {
  const app = read('public/app.js');
  for (const setup of [
    'setupCopyPhoneActions',
    'setupActionDisclosures',
    'setupLostDialog',
    'setupNavigationDrawer',
    'setupFilterDrawer',
    'setupRequiredSelections',
    'setupPwaShell',
    'setupOfflineRetry',
    'setupFormLoading',
  ]) {
    assert.equal((app.match(new RegExp(`${setup}\\(\\);`, 'g')) || []).length, 1);
  }
});
