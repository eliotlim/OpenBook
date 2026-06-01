#!/usr/bin/env node
/**
 * OpenBook server entrypoint — used for BOTH the headless deployment and the
 * desktop sidecar. The desktop spawns this exact program with `--data-dir`
 * (embedded Postgres); a headless deployment runs it with
 * `OPENBOOK_DATABASE_URL` set.
 *
 * Flags / env:
 *   --data-dir <path>   | OPENBOOK_DATA_DIR     embedded mode: cluster location
 *   OPENBOOK_DATABASE_URL | DATABASE_URL        server mode: external Postgres
 *   --host <host>       | (from --bind / OPENBOOK_BIND)
 *   --port <port>       | (from --bind / OPENBOOK_BIND)
 *   --bind <host:port>  | OPENBOOK_BIND          convenience for host+port
 *   --embedded-port <p> | OPENBOOK_EMBEDDED_PORT embedded cluster port
 */
import {resolve} from 'node:path';
import {startServer} from './server';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.OPENBOOK_DATABASE_URL || process.env.DATABASE_URL || undefined;
  const dataDir = flag('data-dir') || process.env.OPENBOOK_DATA_DIR;

  const bind = flag('bind') || process.env.OPENBOOK_BIND;
  let host = flag('host');
  let port = numeric(flag('port'));
  if (bind && host === undefined && port === undefined) {
    const idx = bind.lastIndexOf(':');
    host = bind.slice(0, idx);
    port = numeric(bind.slice(idx + 1));
  }

  const embeddedPort = numeric(flag('embedded-port') ?? process.env.OPENBOOK_EMBEDDED_PORT);

  if (!databaseUrl && !dataDir) {
    console.error(
      'OpenBook server: set OPENBOOK_DATABASE_URL (server mode) or --data-dir / OPENBOOK_DATA_DIR (embedded mode).',
    );
    process.exit(1);
  }

  const running = await startServer({
    databaseUrl,
    dataDir: dataDir ? resolve(dataDir) : undefined,
    // Headless defaults to all interfaces; embedded desktop defaults to loopback.
    host: host ?? (databaseUrl ? '0.0.0.0' : '127.0.0.1'),
    port: port ?? 4319,
    embeddedPort,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
