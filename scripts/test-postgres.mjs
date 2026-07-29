import { spawnSync } from 'node:child_process';

const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const name = `crm-meta-pgtest-${process.pid}-${Date.now()}`.toLowerCase();
const user = 'crm_test';
const password = 'crm_test_password';
const database = 'crm_test';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env || process.env,
  });

  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `Falhou (${result.status}): ${command} ${args.join(' ')}`
      + (result.stderr ? `\n${result.stderr}` : ''),
    );
  }
  return result;
}

let exitCode = 1;

try {
  run(docker, ['version']);
  run(docker, [
    'run', '--detach', '--name', name,
    '--env', `POSTGRES_USER=${user}`,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${database}`,
    '--publish', '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    const status = run(
      docker,
      ['exec', name, 'pg_isready', '-U', user, '-d', database],
      { capture: true, allowFailure: true },
    );
    if (status.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!ready) throw new Error('PostgreSQL 17 não ficou pronto');

  const portOutput = run(
    docker,
    ['port', name, '5432/tcp'],
    { capture: true },
  ).stdout;

  const match = portOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`Porta não encontrada: ${portOutput}`);

  const databaseUrl =
    `postgresql://${user}:${password}@127.0.0.1:${match[1]}/${database}`;

  const result = run(
    process.execPath,
    ['--test', 'test/lead-file-import-postgres.test.js'],
    {
      allowFailure: true,
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: 'false',
        DEFAULT_TENANT_ID: `jsonb-test-${process.pid}`,
      },
    },
  );

  exitCode = result.status ?? 1;
} finally {
  run(
    docker,
    ['rm', '--force', name],
    { capture: true, allowFailure: true },
  );
}

process.exit(exitCode);
