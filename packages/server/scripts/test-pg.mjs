import {spawnSync} from 'node:child_process';

const url = process.env.OPENBOOK_TEST_DATABASE_URL?.trim();
const required = process.env.OPENBOOK_REQUIRE_CONCURRENCY_PG === '1';

if (!url) {
  const notice =
    '[CWD-11] Postgres concurrency suite SKIPPED — set OPENBOOK_TEST_DATABASE_URL to a Postgres server ' +
    'that permits scratch database creation (for example, run docker-compose.test-pg.yml).';
  if (required) {
    console.error(`${notice} OPENBOOK_REQUIRE_CONCURRENCY_PG=1 forbids skipping.`);
    process.exitCode = 1;
  } else {
    console.warn(`${notice} CI requires and runs this suite.`);
  }
} else {
  const executable = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
  const result = spawnSync(executable, ['run', '--config', 'vitest.pg.config.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
