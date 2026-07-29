import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  detectLeadFileContent,
  LeadFileImportError,
  parseLeadCreatedTime,
  parseLeadFile,
  protectCsvExportValue,
  sanitizeLeadImportFilename,
} from '../src/lead-file-import.js';
import { leadFileImportPreviewView } from '../src/views.js';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

function workbookBuffer(rows, { bookType = 'xlsx', sheetName = 'Leads' } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType });
}

function spreadsheetMlBuffer({ unsafe = '' } = {}) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet ss:Name="Leads"><Table>
      <Row><Cell><Data ss:Type="String">id</Data></Cell><Cell><Data ss:Type="String">Nome</Data></Cell><Cell><Data ss:Type="String">WhatsApp</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">fake-001</Data></Cell><Cell><Data ss:Type="String">Pessoa Fictícia</Data></Cell><Cell><Data ss:Type="String">000</Data></Cell></Row>
      ${unsafe}
    </Table></Worksheet>
  </Workbook>`, 'utf8');
}

test('SpreadsheetML 2003 XML salvo como XLS é reconhecido pelo conteúdo', () => {
  const parsed = parseLeadFile(spreadsheetMlBuffer(), 'exportacao.xls');
  assert.equal(parsed.declaredFormat, 'XLS');
  assert.equal(parsed.detectedFormat, 'SPREADSHEETML');
  assert.equal(parsed.format, 'XLS');
  assert.equal(parsed.encoding, 'UTF-8');
  assert.equal(parsed.rows[0].metaLeadId, 'fake-001');
  assert.match(parsed.warnings.join(' '), /formato XML/);
});

test('CSV UTF-16LE com BOM e TAB é reconhecido e preserva ID', () => {
  const text = 'id\tcreated_time\tNome\tWhatsApp\tlead_status\r\n'
    + '000000000000000001\t2026-07-29\tPessoa Fictícia\t000\tnew\r\n';
  const buffer = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  const parsed = parseLeadFile(buffer, 'exportacao.csv');
  assert.equal(parsed.encoding, 'UTF-16LE');
  assert.equal(parsed.delimiter, '\t');
  assert.equal(parsed.rows[0].metaLeadId, '000000000000000001');
  assert.match(parsed.warnings.join(' '), /CSV UTF-16 reconhecido/);
});

test('conteúdo seguro suportado é aceito mesmo com extensão divergente', () => {
  const parsed = parseLeadFile(Buffer.from('id;Nome;WhatsApp\nfake-002;Pessoa Teste;000'), 'dados.xls');
  assert.equal(parsed.declaredFormat, 'XLS');
  assert.equal(parsed.detectedFormat, 'CSV');
  assert.equal(parsed.warnings.length, 1);
});

test('SpreadsheetML rejeita DOCTYPE, fórmula, hyperlink e vínculo externo', () => {
  const safe = spreadsheetMlBuffer().toString('utf8');
  for (const text of [
    safe.replace('<Workbook', '<!DOCTYPE Workbook><Workbook'),
    safe.replace('<Cell><Data ss:Type="String">fake-001', '<Cell ss:Formula="=1+1"><Data ss:Type="String">fake-001'),
    safe.replace('<Cell><Data ss:Type="String">fake-001', '<Cell ss:HRef="https://example.invalid"><Data ss:Type="String">fake-001'),
    safe.replace('</Workbook>', '<ExternalLink/></Workbook>'),
  ]) {
    assert.throws(
      () => parseLeadFile(Buffer.from(text), 'dados.xls'),
      (error) => error.code === 'UNSAFE_WORKBOOK',
    );
  }
});

test('binário desconhecido não é interpretado como texto Windows-1252', () => {
  assert.throws(
    () => detectLeadFileContent(Buffer.from([0, 1, 2, 3, 4, 5])),
    (error) => error.code === 'UNKNOWN_FORMAT',
  );
});

test('CSV aceita vírgula, ponto e vírgula, tab e BOM preservando ID textual', () => {
  for (const separator of [',', ';', '\t']) {
    const csv = Buffer.from(
      `\uFEFFid${separator}created_time${separator}Nome${separator}WhatsApp${separator}lead_status\n`
      + `000123${separator}7/29/26${separator}Ana${separator}11999999999${separator}won`,
    );
    const parsed = parseLeadFile(csv, 'leads.csv');
    assert.equal(parsed.rows[0].metaLeadId, '000123');
    assert.equal(parsed.rows[0].metaCreatedAt.toISOString(), '2026-07-29T03:00:00.000Z');
    assert.equal(parsed.rows[0].rawMeta.lead_status, 'won');
    assert.equal(Object.hasOwn(parsed.rows[0], 'stage'), false);
  }
});

test('XLSX e XLS são aceitos e preservam IDs string maiores que 15 dígitos', () => {
  for (const bookType of ['xlsx', 'biff8']) {
    const extension = bookType === 'xlsx' ? 'xlsx' : 'xls';
    const parsed = parseLeadFile(workbookBuffer([
      ['id', 'created_time', 'Nome', 'WhatsApp'],
      ['00012345678901234567890', new Date('2026-07-29T12:00:00Z'), 'Bia', '5538991142298'],
    ], { bookType }), `leads.${extension}`);
    assert.equal(parsed.rows[0].metaLeadId, '00012345678901234567890');
    assert.deepEqual(parsed.rows[0].errors, []);
  }
});

test('ID numérico seguro é convertido em texto e ID numérico inseguro é recusado', () => {
  const parsed = parseLeadFile(workbookBuffer([
    ['id', 'Nome', 'WhatsApp'],
    [123456789012345, 'Caio', '11999999999'],
    [Number.MAX_SAFE_INTEGER + 1, 'Dora', '11999999999'],
  ]), 'leads.xlsx');
  assert.equal(parsed.rows[0].metaLeadId, '123456789012345');
  assert.equal(parsed.rows[0].errors.includes('ID_MUST_BE_TEXT'), false);
  assert.ok(parsed.rows[1].errors.includes('ID_MUST_BE_TEXT'));
});

test('prefixo tipado de ID exportado pela Meta é removido sem alterar o identificador', () => {
  const parsed = parseLeadFile(
    Buffer.from('id,ad_id,Nome,WhatsApp\nl:123456,ad:987654,Pessoa Teste,11999999999'),
    'leads.csv',
  );
  assert.equal(parsed.rows[0].metaLeadId, '123456');
  assert.equal(parsed.rows[0].metaAdId, '987654');
  assert.equal(parsed.rows[0].errors.length, 0);
});

test('telefones +55, formatados e nome iniciado por arroba são preservados', () => {
  for (const phone of ['+5538999999999', '+55 38 99999-9999', '(38) 99999-9999']) {
    const parsed = parseLeadFile(
      Buffer.from(`id,Nome,WhatsApp\nsafe-id,@Identificador,${phone}`),
      'leads.csv',
    );
    assert.equal(parsed.rows[0].name, '@Identificador');
    assert.equal(parsed.rows[0].phone, phone);
    assert.equal(parsed.rows[0].errors.includes('WHATSAPP_UNSAFE_VALUE'), false);
    assert.equal(parsed.rows[0].errors.length, 0);
  }
});

test('CSV não executa valores iniciados por fórmula e exportação os neutraliza', () => {
  const parsed = parseLeadFile(
    Buffer.from('id,Nome,WhatsApp\nsafe-id,=texto,000'),
    'leads.csv',
  );
  assert.equal(parsed.rows[0].name, '=texto');
  assert.equal(parsed.rows[0].errors.includes('NOME_UNSAFE_VALUE'), false);
  for (const value of ['=1+1', '+cmd', '-valor', '@valor']) {
    assert.equal(protectCsvExportValue(value), `'${value}`);
  }
  assert.equal(protectCsvExportValue('texto'), 'texto');
});

test('datas aceitam formatos documentados sem fallback ambíguo', () => {
  assert.equal(parseLeadCreatedTime('7/29/26').toISOString(), '2026-07-29T03:00:00.000Z');
  assert.equal(parseLeadCreatedTime('7/29/2026').toISOString(), '2026-07-29T03:00:00.000Z');
  assert.equal(parseLeadCreatedTime('2026-07-29').toISOString(), '2026-07-29T03:00:00.000Z');
  assert.equal(parseLeadCreatedTime(46232).toISOString().slice(0, 10), '2026-07-29');
  assert.equal(parseLeadCreatedTime('29/7/26'), null);
  assert.equal(parseLeadCreatedTime('2026-02-30'), null);
});

test('telefone inválido, campos obrigatórios e notação científica viram erros de linha', () => {
  const parsed = parseLeadFile(Buffer.from(
    'id,Nome,WhatsApp\n1e20,,abc',
  ), 'leads.csv');
  assert.ok(parsed.rows[0].errors.includes('ID_SCIENTIFIC_NOTATION'));
  assert.ok(parsed.rows[0].errors.includes('NAME_REQUIRED'));
  assert.ok(parsed.rows[0].errors.includes('PHONE_INVALID'));
});

test('fórmulas e hyperlinks não são executados nem aceitos', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['id', 'Nome', 'WhatsApp'],
    ['', 'Nome', '11999999999'],
  ]);
  sheet.A2 = { t: 'n', f: '1+1', v: 2 };
  sheet.B2.l = { Target: 'https://example.invalid' };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads');
  assert.throws(
    () => parseLeadFile(
      XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
      'leads.xlsx',
    ),
    (error) => error.code === 'UNSAFE_WORKBOOK',
  );
});

test('várias planilhas exigem seleção explícita e arquivo é reprocessado', () => {
  const workbook = XLSX.utils.book_new();
  for (const name of ['Julho', 'Agosto']) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['id', 'Nome', 'WhatsApp'],
      [`id-${name}`, name, '11999999999'],
    ]), name);
  }
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(
    () => parseLeadFile(buffer, 'leads.xlsx'),
    (error) => error instanceof LeadFileImportError
      && error.code === 'SHEET_SELECTION_REQUIRED'
      && error.details.sheets.length === 2,
  );
  assert.equal(
    parseLeadFile(buffer, 'leads.xlsx', { sheetName: 'Agosto' }).rows[0].name,
    'Agosto',
  );
});

test('limites de linhas, colunas, tamanho, extensão, assinatura e nome são aplicados', () => {
  const wideHeaders = ['id', 'Nome', ...Array.from({ length: 49 }, (_, index) => `extra${index}`)];
  assert.throws(
    () => parseLeadFile(workbookBuffer([wideHeaders, ['1', 'Ana']]), 'leads.xlsx'),
    (error) => error.code === 'TOO_MANY_COLUMNS',
  );
  const csvRows = ['id,Nome,WhatsApp'];
  for (let index = 0; index < 2_001; index += 1) {
    csvRows.push(`${index},Ana,11999999999`);
  }
  assert.throws(
    () => parseLeadFile(Buffer.from(csvRows.join('\n')), 'leads.csv'),
    (error) => error.code === 'TOO_MANY_ROWS',
  );
  assert.throws(() => parseLeadFile(Buffer.from('x'), 'leads.exe'), /CSV, XLSX ou XLS/);
  assert.throws(
    () => parseLeadFile(Buffer.from('not zip'), 'leads.xlsx'),
    (error) => error.code === 'UNKNOWN_FORMAT',
  );
  assert.throws(
    () => parseLeadFile(Buffer.alloc(5 * 1024 * 1024 + 1), 'leads.csv'),
    (error) => error.code === 'FILE_TOO_LARGE',
  );
  assert.throws(() => sanitizeLeadImportFilename('../leads.csv'), /Nome de arquivo inválido/);
});

test('nome multipart corrige mojibake conservador sem alterar UTF-8 correto', () => {
  assert.equal(sanitizeLeadImportFilename('Veterinária.xls'), 'Veterinária.xls');
  assert.equal(sanitizeLeadImportFilename('VeterinÃ¡ria.xls'), 'Veterinária.xls');
  assert.equal(sanitizeLeadImportFilename('arquivo ASCII.csv'), 'arquivo ASCII.csv');
  assert.throws(() => sanitizeLeadImportFilename('arquivo\0.csv'), /Nome de arquivo inválido/);
});

test('preview escapa XSS e mantém hash, contagens e confirmação CSRF', () => {
  const html = leadFileImportPreviewView({
    imported: {
      id: '11111111-1111-4111-8111-111111111111',
      original_filename: '<img src=x onerror=alert(1)>.csv',
      format: 'CSV',
      sheet_name: 'Leads',
      sha256: 'a'.repeat(64),
      status: 'PREVIEW',
      counts: { total: 1, new: 1, update: 0, possibleDuplicate: 0, invalid: 0 },
      items: [{
        row_number: 2,
        meta_lead_id: '001',
        name: '<script>alert(1)</script>',
        phone: '11999999999',
        phone_normalized: '5511999999999',
        meta_created_at: '2026-07-29T03:00:00.000Z',
        decision: 'NEW',
        errors: [],
      }],
    },
    csrfToken: '<csrf>',
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /name="_csrf" value="&lt;csrf&gt;"/);
  assert.match(html, /CONFIRM_LEAD_FILE_IMPORT/);
});

test('migration, banco e rota mantêm tenant, preview, CSRF e idempotência', async () => {
  const [migration, database, server, views] = await Promise.all([
    read('sql/007_lead_file_imports.sql'),
    read('src/db.js'),
    read('src/server.js'),
    read('src/views.js'),
  ]);
  assert.match(migration, /CREATE TABLE lead_file_imports/);
  assert.match(migration, /CREATE TABLE lead_file_import_items/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, import_id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id, applied_lead_id\)/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE|DELETE FROM leads/i);
  assert.match(database, /WHERE tenant_id = \$1 AND id = \$2[\s\S]*FOR UPDATE/);
  assert.match(database, /if \(imported\.status === 'COMPLETED'\)/);
  assert.match(database, /if \(!\['NEW', 'UPDATE'\]\.includes\(item\.decision\)\) continue/);
  assert.match(database, /upsertLead\([\s\S]*\{ client \}/);
  assert.match(server, /app\.use\(requireAuth\);[\s\S]*\/operations\/file-imports\/preview[\s\S]*requireCsrf/);
  assert.match(server, /storage: multer\.memoryStorage\(\)/);
  assert.doesNotMatch(server, /express\.static\([^)]*upload/i);
  assert.match(views, /A prévia não altera leads/);
  assert.match(views, /Importar diretamente da Meta/);
  assert.match(views, /Importar arquivo de leads/);
});
