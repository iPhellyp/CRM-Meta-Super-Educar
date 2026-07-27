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
  const stack = await read('docker-stack.yml');
  const migration = deploy.indexOf('npm run migrate');
  const migrationCall = deploy.lastIndexOf('\nrun_swarm_migration\n');
  const appPaused = deploy.indexOf('APP_REPLICAS=0');
  const workerPaused = deploy.indexOf('WORKER_REPLICAS=0');
  const app = deploy.indexOf('APP_REPLICAS=1');
  const worker = deploy.indexOf('WORKER_REPLICAS=1');
  assert.ok(
    migration > 0 &&
      appPaused < migrationCall &&
      workerPaused < migrationCall &&
      migrationCall < app &&
      app < worker,
  );
  assert.doesNotMatch(deploy, /docker run\b/);
  assert.match(deploy, /docker service create/);
  assert.match(deploy, /--replicas 1/);
  assert.match(deploy, /--restart-condition none/);
  assert.match(deploy, /--constraint 'node\.role==manager'/);
  assert.match(deploy, /--network "\$MIGRATION_NETWORK"/);
  assert.match(deploy, /MIGRATION_NETWORK="\$\{MIGRATION_NETWORK:-\$\{stack_name\}_internal\}"/);
  assert.match(stack, /\n  internal:\s*\n/);
  assert.match(deploy, /local image="crm-meta-super-educar:\$\{IMAGE_TAG\}"/);
  assert.match(deploy, /"\$image" npm run migrate/);
  assert.equal((deploy.match(/npm run migrate/g) || []).length, 1);
  assert.match(deploy, /tr -c 'A-Za-z0-9_\.-' '-'/);
  assert.match(deploy, /migration_service="\$\{stack_name\}_migrate_\$\{safe_tag\}_\$\(date \+%s%N\)_\$\$"/);
  assert.match(deploy, /MIGRATION_TIMEOUT_SECONDS="\$\{MIGRATION_TIMEOUT_SECONDS:-300\}"/);
  assert.match(deploy, /state" == "complete" && "\$exit_code" == "0"/);
  assert.match(deploy, /trap cleanup_migration_on_exit EXIT/);
  assert.match(deploy, /local status=\$\?/);
  assert.match(deploy, /docker service rm "\$migration_service"/);
  assert.match(deploy, /cleanup_failed=1/);
  assert.match(deploy, /run_swarm_migration\s*\ncleanup_migration_service/);
  assert.match(deploy, /sanitize_migration_output/);
  assert.match(deploy, /\^\(complete\|failed\|rejected\|shutdown\|orphaned\|remove\)\$/);
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
