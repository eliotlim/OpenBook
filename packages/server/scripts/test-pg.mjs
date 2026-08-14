import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import postgres from 'postgres';

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
  const sql = postgres(url, {max: 1, connect_timeout: 5});
  const scratch = `ob_cwd11_preflight_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let preflightPassed = false;
  try {
    const [server] = await sql`SELECT version() AS version`;
    if (typeof server?.version !== 'string' || !server.version.startsWith('PostgreSQL ')) {
      throw new Error(`unexpected SELECT version() result: ${String(server?.version)}`);
    }
    await sql.unsafe(`CREATE DATABASE ${scratch}`);
    created = true;
    await sql.unsafe(`DROP DATABASE ${scratch}`);
    created = false;
    preflightPassed = true;
  } catch (error) {
    console.error(
      `[CWD-11] Postgres preflight failed for ${url}: unreachable, not a Postgres server, or lacks ` +
        'CREATE DATABASE — check the URL, permissions, and whether a stale process is squatting the port.',
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (created) await sql.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await sql.end({timeout: 1}).catch(() => undefined);
  }

  const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const executable = join(packageDir, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
  if (preflightPassed) {
    const result = spawnSync(executable, ['run', '--config', 'vitest.pg.config.ts'], {
      cwd: packageDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
