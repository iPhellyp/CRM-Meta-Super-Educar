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

test('stack isola as réplicas de postgres, app e worker', async () => {
  const stack = await read('docker-stack.yml');
  const postgres = stack.match(/\n  postgres:[\s\S]*?(?=\n  app:)/)?.[0] || '';
  const app = stack.match(/\n  app:[\s\S]*?(?=\n  worker:)/)?.[0] || '';
  const worker = stack.match(/\n  worker:[\s\S]*?(?=\nvolumes:)/)?.[0] || '';

  assert.match(postgres, /\n\s+replicas: 1\s*\n/);
  assert.doesNotMatch(postgres, /APP_REPLICAS|WORKER_REPLICAS/);
  assert.match(app, /\n\s+replicas: \$\{APP_REPLICAS:-1\}\s*\n/);
  assert.doesNotMatch(app, /WORKER_REPLICAS/);
  assert.match(worker, /\n\s+replicas: \$\{WORKER_REPLICAS:-1\}\s*\n/);
  assert.doesNotMatch(worker, /APP_REPLICAS/);
});

test('deploy migra uma vez antes de app e worker e não importa leads', async () => {
  const deploy = await read('deploy-vps.sh');
  const stack = await read('docker-stack.yml');
  const migration = deploy.indexOf('npm run migrate');
  const migrationCall = deploy.lastIndexOf('run_swarm_migration');
  const appPaused = deploy.indexOf('APP_REPLICAS=0');
  const workerPaused = deploy.indexOf('WORKER_REPLICAS=0');
  const app = deploy.indexOf('APP_REPLICAS=1');
  const worker = deploy.indexOf('WORKER_REPLICAS=1');
  const firstStackDeploy = deploy.indexOf(
    'docker stack deploy --resolve-image never -c docker-stack.yml "$stack_name"',
    workerPaused,
  );
  const postgresAfterPause = deploy.indexOf(
    'wait_for_one_healthy_instance "${stack_name}_postgres"',
    firstStackDeploy,
  );
  assert.ok(
    migration > 0 &&
      appPaused < migrationCall &&
      workerPaused < migrationCall &&
      workerPaused < firstStackDeploy &&
      firstStackDeploy < postgresAfterPause &&
      postgresAfterPause < migrationCall &&
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
  assert.match(deploy, /cut -c1-12/);
  assert.match(deploy, /migration_service="crmm_\$\{safe_tag\}_\$\{epoch\}_\$\$"/);
  assert.doesNotMatch(deploy, /migration_service="w2m_/);
  assert.match(deploy, /MIGRATION_SERVICE_NAME_MAX_LENGTH=63/);
  assert.match(
    deploy,
    /\(\( \$\{#migration_service\} <= MIGRATION_SERVICE_NAME_MAX_LENGTH \)\)/,
  );
  assert.match(deploy, /Nome do servico temporario de migration excede 63 caracteres/);
  assert.ok(`crmm_${'a'.repeat(12)}_${'9'.repeat(10)}_${'9'.repeat(7)}`.length <= 63);
  assert.match(deploy, /MIGRATION_TIMEOUT_SECONDS="\$\{MIGRATION_TIMEOUT_SECONDS:-300\}"/);
  assert.match(deploy, /state" == "complete" && "\$exit_code" == "0"/);
  assert.match(deploy, /trap cleanup_deploy_on_exit EXIT/);
  assert.match(deploy, /local status=\$\?/);
  assert.match(deploy, /docker service rm "\$migration_service"/);
  assert.match(deploy, /cleanup_failed=1/);
  assert.match(
    deploy,
    /run_swarm_migration\s*\nmigration_completed=1\s*\n\s*cleanup_migration_service/,
  );
  assert.match(deploy, /sanitize_migration_output/);
  assert.match(deploy, /\^\(complete\|failed\|rejected\|shutdown\|orphaned\|remove\)\$/);
  assert.match(deploy, /\$\{IMAGE_TAG\+x\}/);
  assert.match(deploy, /IMAGE_TAG nao pode ser vazia/);
  assert.match(deploy, /curl --fail/);
  assert.match(deploy, /docker service inspect --format '\{\{\.Spec\.Mode\.Replicated\.Replicas\}\}'/);
  assert.match(deploy, /"\$desired_replicas" == "1"/);
  assert.match(deploy, /desired-state=running/);
  assert.match(deploy, /"\$\{#task_states\[@\]\}" -eq 1/);
  assert.match(deploy, /"\$\{task_states\[0\]\}" == Running\*/);
  assert.match(deploy, /"\$\{#container_ids\[@\]\}" -eq 1/);
  assert.match(deploy, /"\$health" == "healthy"/);
  const wa2Health = deploy.indexOf('DNS e HTTPS CRM -> WA2 confirmados via Traefik');
  const postgresBeforeBackup = deploy.indexOf(
    'wait_for_one_healthy_instance "${stack_name}_postgres"',
    wa2Health,
  );
  const backup = deploy.indexOf('bash ./scripts/backup.sh');
  const build = deploy.indexOf('docker build');
  assert.ok(
    wa2Health < postgresBeforeBackup &&
      postgresBeforeBackup < backup &&
      backup < build &&
      build < firstStackDeploy,
  );
  assert.equal(
    (
      deploy
        .slice(firstStackDeploy, migrationCall)
        .match(/wait_for_one_healthy_instance "\$\{stack_name\}_postgres"/g) || []
    ).length,
    1,
  );
  assert.match(
    deploy,
    /wait_for_one_healthy_instance "\$\{stack_name\}_postgres"\r?\necho "PostgreSQL permaneceu healthy[\s\S]*?\r?\n\r?\nrun_swarm_migration/,
  );
  assert.doesNotMatch(deploy, /migrate dev/);
  assert.doesNotMatch(deploy, /import[-_: ]*lead|historical-sync/i);
  assert.doesNotMatch(deploy, /set -x|echo .*\b(SECRET|PASSWORD|TOKEN)\b/);
});

test('deploy mantém worker pausado e recupera app após falha', async () => {
  const deploy = await read('deploy-vps.sh');

  assert.match(
    deploy,
    /KEEP_WORKER_PAUSED="\$\{KEEP_WORKER_PAUSED:-false\}"/,
  );
  assert.match(deploy, /services_paused=0/);
  assert.match(deploy, /migration_completed=0/);
  assert.match(deploy, /deploy_completed=0/);
  assert.match(deploy, /previous_app_image=""/);
  assert.match(deploy, /trap cleanup_deploy_on_exit EXIT/);

  assert.match(
    deploy,
    /status != 0 && services_paused == 1 && deploy_completed == 0/,
  );
  assert.match(
    deploy,
    /docker service scale "\$\{stack_name\}_worker=0"/,
  );
  assert.match(
    deploy,
    /docker service scale "\$\{stack_name\}_app=1"/,
  );
  assert.match(deploy, /--image "\$previous_app_image"/);
  assert.match(deploy, /migration_completed=1/);
  assert.match(
    deploy,
    /Worker mantido pausado por KEEP_WORKER_PAUSED=true/,
  );

  const previousImage = deploy.indexOf('previous_app_image="$(');
  const servicesPaused = deploy.indexOf('services_paused=1');
  const migration = deploy.lastIndexOf('run_swarm_migration');
  const appStart = deploy.indexOf('APP_REPLICAS=1');
  const pausedDecision = deploy.indexOf(
    'if [[ "$KEEP_WORKER_PAUSED" == "true" ]]',
  );
  const workerStart = deploy.indexOf('WORKER_REPLICAS=1');

  assert.ok(
    previousImage > 0 &&
      previousImage < servicesPaused &&
      servicesPaused < migration &&
      migration < appStart &&
      appStart < pausedDecision &&
      pausedDecision < workerStart,
  );
});

test('rollback exige tag e backup é verificável sem remoção automática', async () => {
  const deploy = await read('deploy-vps.sh');
  const rollback = await read('scripts/rollback.sh');
  const backup = await read('scripts/backup.sh');
  assert.doesNotMatch(`${deploy}\n${rollback}`, /docker run\b|migrate dev/);
  assert.match(rollback, /target_tag="\$\{1:-\}"/);
  assert.match(rollback, /tag imutavel valida/);
  assert.equal((rollback.match(/--no-healthcheck/g) || []).length, 2);
  assert.match(
    rollback,
    /docker service update --detach=true --no-healthcheck --image "\$image" "\$\{stack_name\}_app"/,
  );
  assert.match(rollback, /docker service scale "\$\{stack_name\}_app=1"/);
  assert.match(rollback, /wait_for_one_running_instance "\$\{stack_name\}_app"/);
  assert.match(rollback, /docker service scale "\$\{stack_name\}_postgres=1"/);
  assert.match(rollback, /wait_for_one_healthy_instance "\$\{stack_name\}_postgres"/);
  assert.match(rollback, /"\$health" == "healthy"/);
  assert.match(rollback, /desired-state=running/);
  assert.match(rollback, /"\$\{#task_states\[@\]\}" -eq 1/);
  assert.match(rollback, /"\$\{task_states\[0\]\}" == Running\*/);
  assert.match(rollback, /"\$\{#container_ids\[@\]\}" -eq 1/);
  assert.match(rollback, /trap ensure_recoverable_services_on_exit EXIT/);
  assert.match(rollback, /"\$postgres_replicas" != "1"/);
  assert.match(
    rollback,
    /"\$app_replicas" == "0" && "\$worker_replicas" == "0"/,
  );
  assert.doesNotMatch(rollback, /app=0/);
  const postgresScale = rollback.indexOf(
    'docker service scale "${stack_name}_postgres=1"',
  );
  const postgresHealthy = rollback.indexOf(
    'wait_for_one_healthy_instance "${stack_name}_postgres"',
    postgresScale,
  );
  const appUpdate = rollback.indexOf(
    'docker service update --detach=true --no-healthcheck --image "$image" "${stack_name}_app"',
  );
  assert.ok(postgresScale > 0 && postgresScale < postgresHealthy && postgresHealthy < appUpdate);
  const keepPaused = rollback.indexOf('KEEP_WORKER_PAUSED:-false}" == "true"');
  const appRunning = rollback.indexOf('wait_for_one_running_instance "${stack_name}_app"');
  const workerRunning = rollback.indexOf('docker service scale "${stack_name}_worker=1"');
  assert.ok(appRunning > 0 && appRunning < keepPaused && keepPaused < workerRunning);
  assert.equal((rollback.match(/worker=0/g) || []).length, 1);
  assert.equal((rollback.match(/worker=1/g) || []).length, 1);
  assert.match(backup, /pg_dump --format=custom/);
  assert.match(backup, /pg_restore --list/);
  assert.match(backup, /sha256sum/);
  assert.match(backup, /BACKUP_ROOT="\$\{BACKUP_ROOT:-\/root\/crm-meta-backups\}"/);
  assert.doesNotMatch(backup, /BACKUP_ROOT="\$\{BACKUP_ROOT:-\.(?:\/|\\)/);
  assert.match(deploy, /BACKUP_ROOT="\$BACKUP_ROOT" bash \.\/scripts\/backup\.sh/);
  assert.match(deploy, /docker service rm "\$migration_service"/);
  assert.doesNotMatch(backup, /find .* -delete|rm .*backup/);
});
