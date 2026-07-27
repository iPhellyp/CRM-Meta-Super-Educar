import { migrate } from './db.js';

export function shouldRunMigrationsOnStartup(env = process.env) {
  const configured = String(env.RUN_MIGRATIONS_ON_STARTUP || '').trim().toLowerCase();
  if (configured) {
    if (!['true', 'false'].includes(configured)) {
      throw new Error('RUN_MIGRATIONS_ON_STARTUP deve ser true ou false');
    }
    return configured === 'true';
  }
  return env.NODE_ENV !== 'production';
}

export async function runStartupMigrations(env = process.env) {
  if (!shouldRunMigrationsOnStartup(env)) return false;
  await migrate();
  return true;
}
