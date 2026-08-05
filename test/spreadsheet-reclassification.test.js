import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import { parseUnivcSpreadsheet } from '../src/lead-file-import.js';

function workbookBuffer() {
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ['id', 'created_time', 'form_id', 'nome_completo', 'whatsapp_number', 'email', 'resposta'],
    ['f:lead-1', '2026-08-05T10:00:00-03:00', 'f:1760211795329890', 'Pessoa Um', '5531999999999', 'um@example.test', 'A'],
  ]);
  const second = XLSX.utils.aoa_to_sheet([
    ['id', 'created_time', 'form_id', 'full_name', 'telefone'],
    ['l:lead-2', '2026-08-05T11:00:00-03:00', 'f:1302569368461458', 'Pessoa Dois', '5531988888888'],
  ]);
  XLSX.utils.book_append_sheet(workbook, first, 'Form 1');
  XLSX.utils.book_append_sheet(workbook, second, 'Form 2');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('parser UNIVC aceita múltiplas abas e aliases de exportação sem perder raw_meta', () => {
  const parsed = parseUnivcSpreadsheet(workbookBuffer(), 'univc.xlsx');
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map((row) => row.metaLeadId), ['lead-1', 'lead-2']);
  assert.equal(parsed.rows[0].metaFormId, '1760211795329890');
  assert.equal(parsed.rows[0].name, 'Pessoa Um');
  assert.equal(parsed.rows[0].email, 'um@example.test');
  assert.equal(parsed.rows[0].rawMeta.resposta, 'A');
  assert.equal(parsed.rows[1].name, 'Pessoa Dois');
  assert.equal(parsed.rows[1].phoneNormalized, '5531988888888');
});

test('contrato de armamento impede classificação anterior e limita o roteamento', () => {
  const migration = fs.readFileSync('sql/019_spreadsheet_reclassification.sql', 'utf8');
  const db = fs.readFileSync('src/db.js', 'utf8');
  assert.match(migration, /awaiting_manual_reclassification BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /lead_reclassification_audits/);
  assert.match(db, /reclassification_armed_at < \$2/);
  assert.match(db, /lead\.dataset_id = \$3/);
  assert.match(db, /MULTIPLE_LEAD_MATCHES/);
  assert.match(db, /system:spreadsheet-reclassification/);
});
