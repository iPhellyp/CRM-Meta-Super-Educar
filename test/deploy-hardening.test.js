import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('stack usa tag imutável, injeta WA2 e desliga migration no startup', async () => {
  const stack = await read('docker-stack.yml');
  assert.equal((stack.match(/crm-meta-super-educar:\$\{IMAGE_TAG:\?/g) || []).length, 2);
  assert.equal((stack.match(/RUN_MIGRATIONS_ON_STARTUP: "false"/g) || []).length, 2);
  for (const name of [
    'WA2_INTERNAL_API_BASE_URL',
    'WA2_INTERNAL_API_SECRET',
    'WA2_INTERNAL_API_TIMEOUT_MS',
  ]) {
    assert.equal((stack.match(new RegExp(`${name}:`, 'g')) || []).length, 2);
  }
  assert.match(stack, /worker:[\s\S]*src\/worker-health\.js/);
});

test('deploy migra uma vez antes de app e worker e não importa leads', async () => {
  const deploy = await read('deploy-vps.sh');
  const migration = deploy.indexOf('npm run migrate');
  const app = deploy.indexOf('APP_REPLICAS=1');
  const worker = deploy.indexOf('WORKER_REPLICAS=1');
  assert.ok(migration > 0 && migration < app && app < worker);
  assert.match(deploy, /\$\{IMAGE_TAG\+x\}/);
  assert.match(deploy, /IMAGE_TAG nao pode ser vazia/);
  assert.match(deploy, /curl --fail/);
  assert.doesNotMatch(deploy, /import[-_: ]*lead|historical-sync/i);
  assert.doesNotMatch(deploy, /set -x|echo .*\b(SECRET|PASSWORD|TOKEN)\b/);
});

test('rollback exige tag e backup é verificável sem remoção automática', async () => {
  const rollback = await read('scripts/rollback.sh');
  const backup = await read('scripts/backup.sh');
  assert.match(rollback, /target_tag="\$\{1:-\}"/);
  assert.match(rollback, /tag imutavel valida/);
  assert.match(backup, /pg_dump --format=custom/);
  assert.match(backup, /pg_restore --list/);
  assert.match(backup, /sha256sum/);
  assert.doesNotMatch(backup, /find .* -delete|rm .*backup/);
});
