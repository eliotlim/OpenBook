import {existsSync} from 'node:fs';
import {join} from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/** A running embedded Postgres: its connection URL and a stop handle. */
export interface EmbeddedHandle {
  url: string;
  stop: () => Promise<void>;
}

const DB_NAME = 'openbook';
const USER = 'openbook';
const PASSWORD = 'openbook';
// Default off the standard 5432 to avoid clashing with a system Postgres.
const DEFAULT_PORT = 5433;

/**
 * Boot a real Postgres locally under `dataDir`. On first run the platform
 * binaries are downloaded and the cluster is initialized; subsequent runs just
 * start the existing cluster. Returns an ordinary `postgresql://` URL so the
 * store connects to it exactly as it would to a remote server.
 */
export async function startEmbeddedPostgres(
  dataDir: string,
  port: number = DEFAULT_PORT,
): Promise<EmbeddedHandle> {
  const databaseDir = join(dataDir, 'pgdata');

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: USER,
    password: PASSWORD,
    port,
    persistent: true,
  });

  // `PG_VERSION` exists once a cluster has been initialized; only initialise
  // when it hasn't, or initdb errors on a populated directory.
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase(DB_NAME);
  } catch {
    // Database already exists from a previous run.
  }

  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${DB_NAME}`;
  return {url, stop: () => pg.stop()};
}
