import 'dotenv/config';
import { closePool, migrate, validateDatabaseConfig } from './db.js';

try {
  validateDatabaseConfig();
  await migrate();
  console.log(JSON.stringify({ level: 'info', msg: 'Migrations concluídas' }));
} finally {
  await closePool();
}
