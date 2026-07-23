import 'dotenv/config';
import { closePool, getWorkerHealth } from './db.js';

try {
  const worker = await getWorkerHealth();
  if (!worker.healthy) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await closePool();
}
