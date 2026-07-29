import crypto from 'node:crypto';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { classifyBrazilianPhone, PHONE_CLASSIFICATIONS } from './phone.js';

export const LEAD_FILE_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  rows: 2_000,
  columns: 50,
});

export const LEAD_FILE_HEADERS = Object.freeze([
  'id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name',
  'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic',
  'platform', 'nome', 'whatsapp', 'lead_status',
]);

const ID_HEADERS = new Set(['id', 'ad_id', 'adset_id', 'campaign_id', 'form_id']);
const FIELD_LIMITS = Object.freeze({
  id: 128,
  created_time: 64,
  ad_id: 128,
  ad_name: 300,
  adset_id: 128,
  adset_name: 300,
  campaign_id: 128,
  campaign_name: 300,
  form_id: 128,
  form_name: 300,
  is_organic: 20,
  platform: 80,
  nome: 200,
  whatsapp: 80,
  lead_status: 100,
});
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/u;
const SCIENTIFIC = /^[+-]?\d+(?:[.,]\d+)?e[+-]?\d+$/i;
const MOJIBAKE_MARKERS = /[ÃÂâð]/u;
const MOJIBAKE_MARKERS_GLOBAL = /[ÃÂâð]/gu;

export class LeadFileImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LeadFileImportError';
    this.code = code;
    this.details = details;
  }
}

export function normalizeLeadImportOriginalName(originalName) {
  const original = String(originalName || '');
  if (!MOJIBAKE_MARKERS.test(original)) return original;
  let current = original;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const knownMultipartRepair = current
      .replaceAll('Ã_Â_', 'Ã¡')
      .replaceAll('Ã_', 'Ã¡');
    const repaired = Buffer.from(knownMultipartRepair, 'latin1').toString('utf8');
    if (repaired.includes('\uFFFD')) break;
    const currentMarkers = [...current.matchAll(MOJIBAKE_MARKERS_GLOBAL)].length;
    const repairedMarkers = [...repaired.matchAll(MOJIBAKE_MARKERS_GLOBAL)].length;
    if (repairedMarkers >= currentMarkers) break;
    current = repaired;
  }
  return current;
}

export function sanitizeLeadImportFilename(originalName) {
  const original = normalizeLeadImportOriginalName(originalName).normalize('NFKC');
  if (!original || original.includes('\0') || /[/\\]/.test(original) || original.includes('..')) {
    throw new LeadFileImportError('INVALID_FILENAME', 'Nome de arquivo inválido.');
  }
  const safe = path.basename(original)
    .replace(INVISIBLE, '')
    .replace(/[^\p{L}\p{N}._() -]/gu, '_')
    .trim()
    .slice(0, 255);
  if (!safe) throw new LeadFileImportError('INVALID_FILENAME', 'Nome de arquivo inválido.');
  return safe;
}

function normalizedHeader(value) {
  return String(value ?? '')
    .replace(/^(?:\uFEFF|ï»¿)/u, '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function fileFormat(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!['.csv', '.xlsx', '.xls'].includes(extension)) {
    throw new LeadFileImportError('UNSUPPORTED_FORMAT', 'Use um arquivo CSV, XLSX ou XLS.');
  }
  return extension.slice(1).toUpperCase();
}

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

export function detectTextEncoding(buffer) {
  if (startsWith(buffer, Buffer.from([0xFF, 0xFE]))) return 'UTF-16LE';
  if (startsWith(buffer, Buffer.from([0xFE, 0xFF]))) return 'UTF-16BE';
  if (startsWith(buffer, Buffer.from([0xEF, 0xBB, 0xBF]))) return 'UTF-8-BOM';
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    utf8.decode(buffer);
    return 'UTF-8';
  } catch {
    try {
      new TextDecoder('windows-1252', { fatal: true }).decode(buffer);
      return 'WINDOWS-1252';
    } catch {
      return null;
    }
  }
}

export function decodeLeadText(buffer, encoding = detectTextEncoding(buffer)) {
  const labels = {
    'UTF-16LE': 'utf-16le',
    'UTF-16BE': 'utf-16be',
    'UTF-8-BOM': 'utf-8',
    'UTF-8': 'utf-8',
    'WINDOWS-1252': 'windows-1252',
  };
  if (!encoding || !labels[encoding]) {
    throw new LeadFileImportError(
      'UNKNOWN_FORMAT',
      'Não foi possível identificar um formato seguro.',
    );
  }
  const offset = encoding === 'UTF-16LE' || encoding === 'UTF-16BE'
    ? 2
    : encoding === 'UTF-8-BOM' ? 3 : 0;
  return new TextDecoder(labels[encoding], { fatal: true })
    .decode(buffer.subarray(offset))
    .replace(/^\uFEFF/u, '');
}

export function isSpreadsheetMlXml(text) {
  const prefix = text.trimStart().slice(0, 500);
  return /^(?:<\?xml\b|<Workbook\b)/i.test(prefix)
    && /urn:schemas-microsoft-com:office:spreadsheet/i.test(text);
}

export function detectTextDelimiter(text) {
  const header = String(text).split(/\r?\n/u, 1)[0] || '';
  const recognized = new Set(LEAD_FILE_HEADERS);
  let best = null;
  for (const delimiter of ['\t', ';', ',']) {
    const headers = header.split(delimiter).map(normalizedHeader);
    const score = headers.filter((value) => recognized.has(value)).length;
    if (!best || score > best.score || (score === best.score && headers.length > best.columns)) {
      best = { delimiter, score, columns: headers.length };
    }
  }
  return best && best.score >= 2 ? best.delimiter : null;
}

export function detectLeadFileContent(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new LeadFileImportError('EMPTY_FILE', 'O arquivo está vazio.');
  }
  if (buffer.length > LEAD_FILE_LIMITS.bytes) {
    throw new LeadFileImportError('FILE_TOO_LARGE', 'O arquivo excede 5 MB.');
  }
  if (startsWith(buffer, Buffer.from([0x50, 0x4B]))) {
    return { detectedFormat: 'XLSX', encoding: null, delimiter: null };
  }
  if (startsWith(buffer, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))) {
    return { detectedFormat: 'XLS', encoding: null, delimiter: null };
  }
  const encoding = detectTextEncoding(buffer);
  if (!encoding) {
    throw new LeadFileImportError('UNKNOWN_FORMAT', 'Não foi possível identificar um formato seguro.');
  }
  let text;
  try {
    text = decodeLeadText(buffer, encoding);
  } catch {
    throw new LeadFileImportError('INVALID_ENCODING', 'Não foi possível decodificar o arquivo com segurança.');
  }
  if (isSpreadsheetMlXml(text)) {
    return { detectedFormat: 'SPREADSHEETML', encoding, delimiter: null, text };
  }
  const delimiter = detectTextDelimiter(text);
  if (delimiter) return { detectedFormat: 'CSV', encoding, delimiter, text };
  throw new LeadFileImportError('UNKNOWN_FORMAT', 'Não foi possível identificar um formato seguro.');
}

export function validateDetectedFileSafety(buffer, detection) {
  const { detectedFormat, text = '' } = detection;
  if (detectedFormat === 'SPREADSHEETML') {
    if (
      /<!DOCTYPE|<!ENTITY|<!ELEMENT|<!ATTLIST|<!NOTATION|<(?:\w+:)?(?:include|script)\b|<Macro\b/i
        .test(text)
    ) {
      throw new LeadFileImportError('UNSAFE_WORKBOOK', 'O arquivo contém conteúdo XML não permitido.');
    }
    if (
      /\b(?:ss:)?Formula\s*=|<(?:\w+:)?Hyperlink\b|\b(?:ss:)?HRef\s*=|<(?:\w+:)?External/i
        .test(text)
    ) {
      throw new LeadFileImportError(
        'UNSAFE_WORKBOOK',
        'O arquivo contém fórmula, hyperlink ou conteúdo externo não permitido.',
      );
    }
  }
  if (detectedFormat === 'XLSX') {
    const archiveNames = buffer.toString('latin1');
    if (/vbaProject\.bin|xl\/externalLinks\/|xl\/embeddings\//i.test(archiveNames)) {
      throw new LeadFileImportError(
        'UNSAFE_WORKBOOK',
        'O arquivo contém fórmula, hyperlink ou conteúdo externo não permitido.',
      );
    }
  }
}

function validateSignature(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new LeadFileImportError('EMPTY_FILE', 'O arquivo está vazio.');
  }
  if (buffer.length > LEAD_FILE_LIMITS.bytes) {
    throw new LeadFileImportError('FILE_TOO_LARGE', 'O arquivo excede 5 MB.');
  }
  return format;
}

function readWorkbook(buffer, detection) {
  try {
    const textual = detection.detectedFormat === 'CSV'
      || detection.detectedFormat === 'SPREADSHEETML';
    return XLSX.read(textual ? detection.text : buffer, {
      type: textual ? 'string' : 'buffer',
      raw: true,
      FS: detection.delimiter || undefined,
      // Mantém datas de SpreadsheetML como serial/texto para que valores sem
      // timezone sejam interpretados explicitamente em America/Sao_Paulo.
      cellDates: false,
      cellFormula: detection.detectedFormat !== 'SPREADSHEETML',
      cellHTML: false,
      cellNF: false,
      WTF: false,
      dense: false,
      password: undefined,
    });
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    const code = /password|encrypted|encryption/.test(message)
      ? 'ENCRYPTED_FILE'
      : 'INVALID_WORKBOOK';
    throw new LeadFileImportError(code, 'Não foi possível ler o arquivo informado.');
  }
}

function sheetDimensions(sheet) {
  if (!sheet?.['!ref']) return null;
  const range = XLSX.utils.decode_range(sheet['!ref']);
  return {
    range,
    rows: range.e.r - range.s.r + 1,
    columns: range.e.c - range.s.c + 1,
  };
}

function relevantSheets(workbook) {
  return workbook.SheetNames.filter((name) => {
    const dimensions = sheetDimensions(workbook.Sheets[name]);
    return dimensions && dimensions.rows > 1;
  });
}

function assertWorkbookHasNoActiveContent(workbook) {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    for (const [address, cell] of Object.entries(sheet || {})) {
      if (address.startsWith('!')) continue;
      if (cell?.f || cell?.l) {
        throw new LeadFileImportError(
          'UNSAFE_WORKBOOK',
          'Fórmulas e hyperlinks não são aceitos.',
        );
      }
    }
  }
}

function cellAt(sheet, row, column) {
  return sheet[XLSX.utils.encode_cell({ r: row, c: column })];
}

function cellText(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return '';
  if (cell.v instanceof Date) return cell.v;
  return typeof cell.v === 'string' ? cell.v : cell.v;
}

function excelSerialToDate(serial) {
  const parsed = XLSX.SSF.parse_date_code(serial);
  if (!parsed) return null;
  const date = new Date(Date.UTC(
    parsed.y,
    parsed.m - 1,
    parsed.d,
    parsed.H + 3,
    parsed.M,
    parsed.S,
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseLeadCreatedTime(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === 'number') return excelSerialToDate(value);
  const text = String(value).trim();
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const month = Number(match[1]);
    const day = Number(match[2]);
    const hours = Number(match[4] || 0);
    const minutes = Number(match[5] || 0);
    const seconds = Number(match[6] || 0);
    const date = new Date(Date.UTC(year, month - 1, day, hours + 3, minutes, seconds));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return null;
    return date;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return null;
  const calendarCheck = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    calendarCheck.getUTCFullYear() !== Number(match[1]) ||
    calendarCheck.getUTCMonth() !== Number(match[2]) - 1 ||
    calendarCheck.getUTCDate() !== Number(match[3])
  ) return null;
  const parsed = new Date(
    match[4]
      ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}${match[7] || '-03:00'}`
      : `${match[1]}-${match[2]}-${match[3]}T00:00:00-03:00`,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function safeString(cell, header, errors) {
  const value = cellText(cell);
  if (value === '') return '';
  if (cell?.f || cell?.l) {
    errors.push(`${header.toUpperCase()}_UNSAFE_VALUE`);
    return '';
  }
  if (typeof value !== 'string') {
    if (ID_HEADERS.has(header)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value);
      }
      errors.push(`${header.toUpperCase()}_MUST_BE_TEXT`);
    }
    return String(value);
  }
  let normalized = value.normalize('NFKC').trim();
  if (ID_HEADERS.has(header)) {
    const exportedMetaId = /^[A-Za-z]{1,16}:([A-Za-z0-9_-]+)$/u.exec(normalized);
    if (exportedMetaId) normalized = exportedMetaId[1];
  }
  if (INVISIBLE.test(normalized)) errors.push(`${header.toUpperCase()}_INVISIBLE_CHAR`);
  if (normalized.length > FIELD_LIMITS[header]) errors.push(`${header.toUpperCase()}_TOO_LONG`);
  if (ID_HEADERS.has(header)) {
    if (/\s/.test(normalized)) errors.push(`${header.toUpperCase()}_HAS_SPACES`);
    if (SCIENTIFIC.test(normalized)) errors.push(`${header.toUpperCase()}_SCIENTIFIC_NOTATION`);
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) errors.push(`${header.toUpperCase()}_INVALID`);
  }
  return normalized.slice(0, FIELD_LIMITS[header]);
}

export function protectCsvExportValue(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  return /^[=+\-@]/u.test(text) ? `'${text}` : text;
}

function parseSheet(sheet, sheetName) {
  const dimensions = sheetDimensions(sheet);
  if (!dimensions || dimensions.rows < 2) {
    throw new LeadFileImportError('EMPTY_SHEET', 'A planilha selecionada não possui leads.');
  }
  if (dimensions.columns > LEAD_FILE_LIMITS.columns) {
    throw new LeadFileImportError('TOO_MANY_COLUMNS', 'A planilha excede 50 colunas.');
  }
  if (dimensions.rows - 1 > LEAD_FILE_LIMITS.rows) {
    throw new LeadFileImportError('TOO_MANY_ROWS', 'A planilha excede 2.000 linhas.');
  }

  const columns = new Map();
  for (let column = dimensions.range.s.c; column <= dimensions.range.e.c; column += 1) {
    const header = normalizedHeader(cellText(cellAt(sheet, dimensions.range.s.r, column)));
    if (!header) continue;
    if (columns.has(header)) {
      throw new LeadFileImportError('DUPLICATE_HEADER', `Cabeçalho duplicado: ${header}.`);
    }
    if (LEAD_FILE_HEADERS.includes(header)) columns.set(header, column);
  }
  if (!columns.has('id') || !columns.has('nome')) {
    throw new LeadFileImportError('MISSING_REQUIRED_HEADERS', 'Os cabeçalhos id e Nome são obrigatórios.');
  }

  const rows = [];
  for (let rowNumber = dimensions.range.s.r + 1; rowNumber <= dimensions.range.e.r; rowNumber += 1) {
    const errors = [];
    const values = {};
    let hasValue = false;
    for (const header of LEAD_FILE_HEADERS) {
      const cell = columns.has(header) ? cellAt(sheet, rowNumber, columns.get(header)) : null;
      let value;
      if (header === 'created_time') {
        if (cell?.f || cell?.l) {
          errors.push('CREATED_TIME_UNSAFE_VALUE');
          value = '';
        } else {
          value = cellText(cell);
        }
      } else {
        value = safeString(cell, header, errors);
      }
      values[header] = value;
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
    }
    if (!hasValue) continue;
    if (!values.id) errors.push('ID_REQUIRED');
    if (!values.nome) errors.push('NAME_REQUIRED');

    const createdAt = parseLeadCreatedTime(values.created_time);
    if (values.created_time !== '' && !createdAt) errors.push('CREATED_TIME_INVALID');
    const phone = classifyBrazilianPhone(values.whatsapp);
    if (phone.status !== PHONE_CLASSIFICATIONS.VALID) errors.push(phone.status);

    const rawMeta = Object.fromEntries(
      LEAD_FILE_HEADERS.map((header) => [
        header,
        values[header] instanceof Date
          ? values[header].toISOString()
          : String(values[header] ?? ''),
      ]),
    );
    rows.push({
      rowNumber: rowNumber + 1,
      metaLeadId: values.id,
      name: values.nome,
      phone: values.whatsapp,
      phoneNormalized: phone.phoneNormalized,
      metaCreatedAt: createdAt,
      metaAdId: values.ad_id || null,
      metaAdsetId: values.adset_id || null,
      metaCampaignId: values.campaign_id || null,
      metaFormId: values.form_id || null,
      rawMeta,
      errors: [...new Set(errors)],
    });
  }
  if (!rows.length) throw new LeadFileImportError('EMPTY_SHEET', 'A planilha selecionada não possui leads.');
  return { sheetName, rows };
}

export function parseLeadFile(buffer, originalName, { sheetName = '' } = {}) {
  const filename = sanitizeLeadImportFilename(originalName);
  const declaredFormat = fileFormat(filename);
  validateSignature(buffer, declaredFormat);
  const detection = detectLeadFileContent(buffer);
  validateDetectedFileSafety(buffer, detection);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const workbook = readWorkbook(buffer, detection);
  assertWorkbookHasNoActiveContent(workbook);
  if (workbook.Workbook?.Names?.some((item) => /\[[^\]]+\]/.test(String(item.Ref || '')))) {
    throw new LeadFileImportError('UNSAFE_WORKBOOK', 'Vínculos externos não são aceitos.');
  }
  const candidates = relevantSheets(workbook);
  if (!candidates.length) throw new LeadFileImportError('EMPTY_FILE', 'O arquivo não possui uma planilha com leads.');
  if (!sheetName && candidates.length > 1) {
    throw new LeadFileImportError(
      'SHEET_SELECTION_REQUIRED',
      'Selecione uma das planilhas com dados e envie o arquivo novamente.',
      { sheets: candidates.slice(0, 20) },
    );
  }
  const selected = sheetName || candidates[0];
  if (!candidates.includes(selected)) {
    throw new LeadFileImportError('INVALID_SHEET', 'A planilha selecionada é inválida.');
  }
  const parsed = parseSheet(workbook.Sheets[selected], selected);
  const warnings = declaredFormat === detection.detectedFormat
    || (declaredFormat === 'XLS' && detection.detectedFormat === 'SPREADSHEETML')
    ? []
    : [`A extensão indica ${declaredFormat}, mas o conteúdo seguro foi reconhecido como ${detection.detectedFormat}.`];
  if (detection.detectedFormat === 'SPREADSHEETML') {
    warnings.unshift('Este arquivo do Excel usa o formato XML e foi reconhecido.');
  }
  if (detection.detectedFormat === 'CSV' && detection.encoding.startsWith('UTF-16')) {
    warnings.unshift('CSV UTF-16 reconhecido.');
  }
  return {
    filename,
    // O schema legado persiste somente CSV/XLS/XLSX; a detecção detalhada fica na prévia.
    format: declaredFormat,
    declaredFormat,
    detectedFormat: detection.detectedFormat,
    encoding: detection.encoding,
    delimiter: detection.delimiter,
    warnings,
    sha256,
    sheetName: selected,
    rows: parsed.rows,
  };
}

export function publicLeadFileImportError(error) {
  if (error instanceof LeadFileImportError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: 'IMPORT_FAILED',
    message: 'Não foi possível processar o arquivo. Verifique o conteúdo e tente novamente.',
    details: {},
  };
}
