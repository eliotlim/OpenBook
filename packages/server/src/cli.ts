import {resolve} from 'node:path';
import type {PGliteOptions} from '@electric-sql/pglite';
import {startServer} from './server';

/**
 * Shared CLI runner for both entrypoints (`bin.ts` for Node, `bin.bun.ts` for
 * the compiled sidecar). Parses flags/env, starts the server, prints a
 * machine-readable readiness line, and wires graceful shutdown.
 *
 * Flags / env:
 *   --data-dir <path>   | OPENBOOK_DATA_DIR        embedded mode: PGlite location
 *   OPENBOOK_DATABASE_URL | DATABASE_URL           server mode: external Postgres
 *   --host <host>  --port <port>  | --bind <h:p> | OPENBOOK_BIND
 *   --book-dir <path>   | OPENBOOK_BOOK_DIR        on-disk book-file mirror folder
 *   OPENBOOK_TRASH_RETENTION_MS         how long trash is kept before purge
 *   OPENBOOK_TRASH_CLEANUP_INTERVAL_MS  how often the cleanup job runs (0 = off)
 */
export interface CliOverrides {
  /** PGlite asset overrides supplied by the compiled sidecar. */
  pgliteAssets?: Partial<PGliteOptions>;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function runCli(overrides: CliOverrides = {}): Promise<void> {
  const databaseUrl = process.env.OPENBOOK_DATABASE_URL || process.env.DATABASE_URL || undefined;
  const dataDir = flag('data-dir') || process.env.OPENBOOK_DATA_DIR;
  const bookDir = flag('book-dir') || process.env.OPENBOOK_BOOK_DIR;

  const bind = flag('bind') || process.env.OPENBOOK_BIND;
  let host = flag('host');
  let port = numeric(flag('port'));
  if (bind && host === undefined && port === undefined) {
    const idx = bind.lastIndexOf(':');
    host = bind.slice(0, idx);
    port = numeric(bind.slice(idx + 1));
  }

  if (!databaseUrl && !dataDir) {
    console.error(
      'OpenBook server: set OPENBOOK_DATABASE_URL (server mode) or --data-dir / OPENBOOK_DATA_DIR (embedded mode).',
    );
    process.exit(1);
  }

  const running = await startServer({
    databaseUrl,
    dataDir: dataDir ? resolve(dataDir) : undefined,
    bookDir: bookDir ? resolve(bookDir) : undefined,
    pgliteAssets: overrides.pgliteAssets,
    // Headless defaults to all interfaces; embedded desktop to loopback.
    host: host ?? (databaseUrl ? '0.0.0.0' : '127.0.0.1'),
    port: port ?? 4319,
    trashRetentionMs: numeric(process.env.OPENBOOK_TRASH_RETENTION_MS),
    trashCleanupIntervalMs: numeric(process.env.OPENBOOK_TRASH_CLEANUP_INTERVAL_MS),
  });

  console.log(`OpenBook server listening on ${running.url}`);
  // Machine-readable readiness line the desktop host parses from stdout.
  console.log(`OPENBOOK_READY ${running.url}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
