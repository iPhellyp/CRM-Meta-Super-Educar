import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const BATCH_SIZE = 250;

const TABLES = [
  { name: 'WhatsappInstance', columns: ['id', 'name', 'phone', 'role', 'status', 'sessionKey', 'isDefault', 'lastConnectedAt', 'lastSyncAt', 'createdAt', 'updatedAt'] },
  { name: 'ImportBatch', columns: ['id', 'filename', 'totalRows', 'insertedRows', 'duplicatedRows', 'invalidRows', 'createdAt'] },
  { name: 'WhatsappSession', columns: ['id', 'instanceId', 'status', 'qrCode', 'connectedPhone', 'lastError', 'createdAt', 'updatedAt'] },
  { name: 'Contact', columns: ['id', 'instanceId', 'name', 'phoneRaw', 'phoneNormalized', 'message', 'source', 'optedOut', 'createdAt', 'updatedAt'] },
  { name: 'WhatsappChat', columns: ['id', 'instanceId', 'jid', 'name', 'isGroup', 'unreadCount', 'lastMessageAt', 'lastMessageText', 'lastInboundAt', 'lastOutboundAt', 'createdAt', 'updatedAt'] },
  { name: 'WhatsappContact', columns: ['id', 'instanceId', 'jid', 'phone', 'name', 'pushName', 'isBusiness', 'createdAt', 'updatedAt'] },
  { name: 'WhatsappLabel', columns: ['id', 'instanceId', 'waLabelId', 'name', 'color', 'predefined', 'deleted', 'rawJson', 'createdAt', 'updatedAt'] },
  { name: 'WhatsappMessage', columns: ['id', 'instanceId', 'chatId', 'waMessageId', 'jid', 'fromMe', 'senderJid', 'timestamp', 'messageType', 'text', 'rawJson', 'createdAt'] },
  { name: 'WhatsappChatLabel', columns: ['id', 'instanceId', 'chatId', 'labelId', 'jid', 'createdAt', 'updatedAt'] },
  { name: 'Campaign', columns: ['id', 'instanceId', 'name', 'defaultMessage', 'intervalMinutes', 'status', 'targetMode', 'targetLabelId', 'excludeGroups', 'excludeAlreadySentDays', 'dedupeMode', 'dedupeKey', 'creationKey', 'maxRecipients', 'sendWindowStart', 'sendWindowEnd', 'createdAt', 'updatedAt', 'scheduledAt', 'startedAt', 'completedAt', 'mediaKind', 'mediaPath', 'mediaOriginalName', 'mediaMimeType', 'mediaSizeBytes', 'lastError', 'dispatchConfig', 'nextDispatchAt'] },
  { name: 'WhatsappIdentity', columns: ['id', 'instanceId', 'lidJid', 'phoneJid', 'phoneNormalized', 'source', 'confidence', 'evidence', 'firstSeenAt', 'lastSeenAt'], optional: true },
  { name: 'WhatsappLabelEvent', columns: ['id', 'eventId', 'instanceId', 'chatId', 'jid', 'phoneNormalized', 'waLabelId', 'operation', 'observedAt', 'source', 'correlationKey', 'eligibleForCrm', 'ineligibleReason', 'createdAt'] },
  { name: 'CrmLabelEventDelivery', columns: ['id', 'eventId', 'payload', 'status', 'attempts', 'nextAttemptAt', 'lastError', 'sentAt', 'createdAt', 'updatedAt'], optional: true },
  { name: 'CampaignRecipient', columns: ['id', 'instanceId', 'campaignId', 'contactId', 'chatId', 'jid', 'messageFinal', 'status', 'dedupeKey', 'skippedReason', 'attemptCount', 'lastAttemptAt', 'scheduledAt', 'sentAt', 'error', 'createdAt', 'updatedAt'] },
  { name: 'SendLog', columns: ['id', 'instanceId', 'jid', 'chatId', 'campaignId', 'recipientId', 'messageHash', 'status', 'error', 'sentAt', 'createdAt'] },
];

const mode = process.argv.filter((arg) => arg === '--dry-run' || arg === '--execute');
if (mode.length !== 1) throw new Error('USE_EXACTLY_ONE_MODE');

const sourceUrl = String(process.env.WA2_DATABASE_URL || '').trim();
const targetUrl = String(process.env.DATABASE_URL || '').trim();
if (!sourceUrl || !targetUrl) throw new Error('DATABASE_URLS_REQUIRED');
if (sourceUrl === targetUrl) throw new Error('SOURCE_TARGET_SAME');

const sourcePool = new Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 10_000 });
const targetPool = new Pool({ connectionString: targetUrl, max: 2, connectionTimeoutMillis: 10_000 });

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableRef(name) {
  return `public.${quoteIdentifier(name)}`;
}

async function hasTable(client, name) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [tableRef(name)]);
  return result.rows[0].exists === true;
}

async function countRows(client, name) {
  const result = await client.query(`SELECT count(*)::text AS count FROM ${tableRef(name)}`);
  return BigInt(result.rows[0].count);
}

async function loadRows(client, table) {
  const columns = table.columns.map(quoteIdentifier).join(', ');
  const result = await client.query(`SELECT ${columns} FROM ${tableRef(table.name)} ORDER BY ${quoteIdentifier('id')}`);
  return result.rows;
}

async function insertRows(client, table, rows) {
  if (!rows.length) return 0;
  const columns = table.columns.map(quoteIdentifier).join(', ');
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = table.columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * table.columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const result = await client.query(
      `INSERT INTO ${tableRef(table.name)} (${columns}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

async function setSequences(client) {
  for (const table of ['WhatsappLabelEvent', 'CrmLabelEventDelivery']) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT max("id") FROM ${tableRef(table)}), 1), (SELECT count(*) > 0 FROM ${tableRef(table)}))`,
      [tableRef(table)],
    );
  }
}

async function validateTables(sourceClient, targetClient) {
  const available = [];
  for (const table of TABLES) {
    const sourceExists = await hasTable(sourceClient, table.name);
    if (!sourceExists && table.optional) continue;
    if (!sourceExists) throw new Error(`SOURCE_TABLE_MISSING:${table.name}`);
    if (!(await hasTable(targetClient, table.name))) throw new Error(`TARGET_SCHEMA_NOT_READY:${table.name}`);
    available.push(table);
  }
  return available;
}

async function run() {
  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();
  try {
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await validateTables(sourceClient, targetClient);
    const datasets = [];
    for (const table of tables) {
      const rows = await loadRows(sourceClient, table);
      const targetBefore = await countRows(targetClient, table.name);
      datasets.push({ table, rows, targetBefore });
    }

    if (mode[0] === '--dry-run') {
      await sourceClient.query('ROLLBACK');
      console.log(JSON.stringify({
        mode: 'DRY_RUN',
        tables: datasets.map(({ table, rows, targetBefore }) => ({
          table: table.name,
          source: rows.length,
          targetBefore: targetBefore.toString(),
        })),
      }));
      return;
    }

    await targetClient.query('BEGIN');
    const results = [];
    try {
      for (const { table, rows, targetBefore } of datasets) {
        const inserted = await insertRows(targetClient, table, rows);
        const targetAfter = await countRows(targetClient, table.name);
        if (targetAfter < BigInt(rows.length)) throw new Error(`VERIFY_COUNT_FAILED:${table.name}`);
        results.push({
          table: table.name,
          source: rows.length,
          inserted,
          alreadyPresent: rows.length - inserted,
          targetBefore: targetBefore.toString(),
          targetAfter: targetAfter.toString(),
        });
      }
      await setSequences(targetClient);
      await targetClient.query('COMMIT');
    } catch (error) {
      await targetClient.query('ROLLBACK');
      throw error;
    }
    await sourceClient.query('COMMIT');
    console.log(JSON.stringify({ mode: 'EXECUTE', tables: results }));
  } finally {
    sourceClient.release();
    targetClient.release();
  }
}

try {
  await run();
} catch (error) {
  const code = String(error?.message || '').split(':')[0];
  console.error(JSON.stringify({
    status: 'ERROR',
    code: /^[A-Z0-9_.-]{1,80}$/.test(code) ? code : 'WA2_DATA_MIGRATION_FAILED',
  }));
  process.exitCode = 1;
} finally {
  await Promise.all([sourcePool.end(), targetPool.end()]);
}
