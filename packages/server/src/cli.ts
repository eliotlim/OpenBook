import {existsSync} from 'node:fs';
import {delimiter, join, resolve} from 'node:path';
import type {PGliteOptions} from '@electric-sql/pglite';
import {startServer} from './server';
import {installSidecarParentDeath} from './parentDeath';
import {createPgliteDb, PostgresDb, type Db} from './db';
import {isLedgerVerifyAdvisory, verifyLedger} from './ledgerVerify';

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
 *   --access-token <t>  | OPENBOOK_ACCESS_TOKEN    require this token on /api/*
 *   --ledger-export-root <paths> | OPENBOOK_LEDGER_EXPORT_ROOTS
 *                                            extra dirs the ledger auto-export
 *                                            may write into (<data-dir>/exports
 *                                            is always allowed). Both accept a
 *                                            path-delimiter-separated list; the
 *                                            flag may also be repeated.
 *   --verify-ledger                          run the independent ledger verifier
 *                                            and exit (0 clean-or-advisory-only /
 *                                            1 tamper findings / 2 error). Advisory
 *                                            findings (current-policy, e.g.
 *                                            evidence-required-missing) are still
 *                                            printed but do not fail the run —
 *                                            they are EXPECTED on a healthy book
 *                                            that enables a policy over history,
 *                                            and a permanently red backup script
 *                                            is how a tamper alarm gets ignored.
 *   --fail-on-advisory                       with --verify-ledger: exit 1 on ANY
 *                                            finding, advisory included (strict
 *                                            callers).
 *   OPENBOOK_TRASH_RETENTION_MS         how long trash is kept before purge
 *   OPENBOOK_TRASH_CLEANUP_INTERVAL_MS  how often the cleanup job runs (0 = off)
 */
export interface CliOverrides {
  /** PGlite asset overrides supplied by the compiled sidecar. */
  pgliteAssets?: Partial<PGliteOptions>;
  /**
   * The viewer runtime bundle (JS source) the compiled sidecar embeds for the
   * book mirror's `_openbook/viewer.js`. Under Node this is omitted and the
   * server falls back to its own disk lookup (see `resolveViewerRuntime`).
   */
  viewerRuntime?: string;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * A repeatable, `path.delimiter`-separated path-list flag (LGR-7 S4). Plain
 * {@link flag} reads only the FIRST occurrence, so a repeated flag would be
 * silently ignored — for a list-valued option that silence is the bug. Every
 * occurrence is collected, each value split on the platform path delimiter,
 * and each entry resolved to an absolute path.
 */
function pathListFlag(name: string): string[] | undefined {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== `--${name}`) continue;
    const raw = process.argv[i + 1];
    if (raw === undefined) continue;
    for (const part of raw.split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed.length > 0) values.push(resolve(trimmed));
    }
  }
  return values.length > 0 ? values : undefined;
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
  const accessToken = flag('access-token') || process.env.OPENBOOK_ACCESS_TOKEN;
  const socketPath = flag('socket') || process.env.OPENBOOK_SOCKET;

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

  // LGR-7: `openbook-server --verify-ledger` runs the independent ledger
  // invariant verifier against the book and exits — no HTTP server starts.
  // Read-only. Exit 0 = clean (or no ledger); exit 1 = findings; exit 2 =
  // could not open/verify (e.g. the data dir is locked by a running server —
  // use the owner-gated `GET /api/ledger/verify` route against a live one).
  if (process.argv.includes('--verify-ledger')) {
    let db: Db | null = null;
    // The intended exit code, assigned to `process.exitCode` ONLY in the
    // `finally`, AFTER the store closes. Setting it earlier silently reported
    // success for every failure on an embedded book: PGlite's close tears down
    // its Emscripten runtime, and that teardown writes `process.exitCode = 0`
    // over whatever was there — so `--verify-ledger` on a PGlite data dir
    // exited 0 regardless of findings (exit 2 on a typo'd dir survived only
    // because that path returns before a database ever opens).
    let verifyExit: 0 | 1 | 2 = 2;
    try {
      if (!databaseUrl) {
        // A typo'd --data-dir must NOT silently create an empty cluster and
        // then report "no ledger — trivially clean". An existing PGlite data
        // dir always carries PG_VERSION.
        const dir = resolve(dataDir as string);
        if (!existsSync(join(dir, 'PG_VERSION'))) {
          console.error(`OpenBook ledger verify: ${dir} is not an OpenBook data directory (no PG_VERSION).`);
          return;
        }
        db = await createPgliteDb(dir, overrides.pgliteAssets);
      } else {
        db = new PostgresDb(databaseUrl);
      }
      const report = await verifyLedger(db);
      // NEVER process.exit() here: it skips the `finally` below (leaking the
      // PGlite dir lock and forcing the next start through stale-lock recovery)
      // and can truncate this JSON on a pipe.
      console.log(JSON.stringify(report, null, 2));
      // SEVERITY-AWARE exit (LGR-14 Q3), keyed off the code union — never
      // message text: tamper findings fail the run; advisory (current-policy)
      // findings are printed but exit 0, because they are EXPECTED on a
      // healthy book that enables evidence-required over bare history — a
      // backup script that goes permanently red the day a toggle flips is how
      // operators learn to ignore the one alarm that matters.
      const tamper = report.findings.filter((f) => !isLedgerVerifyAdvisory(f.code));
      const advisories = report.findings.length - tamper.length;
      const failOnAdvisory = process.argv.includes('--fail-on-advisory');
      if (!report.initialized) console.error('OpenBook ledger verify: no ledger on this library (trivially clean).');
      else if (report.findings.length === 0) console.error('OpenBook ledger verify: CLEAN — every invariant holds.');
      else if (tamper.length === 0) {
        console.error(
          `OpenBook ledger verify: ${advisories} policy advisory finding(s), no tamper findings${failOnAdvisory ? ' (failing: --fail-on-advisory)' : ''}.`,
        );
      } else console.error(`OpenBook ledger verify: ${tamper.length} tamper finding(s), ${advisories} advisory.`);
      verifyExit = tamper.length > 0 || (failOnAdvisory && report.findings.length > 0) ? 1 : 0;
      return;
    } catch (err) {
      console.error('OpenBook ledger verify failed:', err);
      return;
    } finally {
      await db?.close().catch(() => {});
      process.exitCode = verifyExit; // after close — see verifyExit's comment
    }
  }

  // Bind TCP when a host/port/bind was explicitly requested, or when there is no
  // socket to serve over. A `--socket` with no explicit TCP flags is portless
  // (the desktop default); the LAN bind is added later by passing `--host`/`--port`.
  const wantTcp = host !== undefined || port !== undefined || !socketPath;

  const running = await startServer({
    databaseUrl,
    dataDir: dataDir ? resolve(dataDir) : undefined,
    bookDir: bookDir ? resolve(bookDir) : undefined,
    accessToken: accessToken || undefined,
    socketPath: socketPath ? resolve(socketPath) : undefined,
    pgliteAssets: overrides.pgliteAssets,
    viewerRuntime: overrides.viewerRuntime,
    // Headless defaults to all interfaces; embedded desktop to loopback.
    host: wantTcp ? host ?? (databaseUrl ? '0.0.0.0' : '127.0.0.1') : undefined,
    port: wantTcp ? port ?? 4319 : undefined,
    // LGR-7 S2: extra directories the ledger auto-export may write into. Only
    // the operator can widen this (flag/env) — never a request.
    ledgerExportRoots: pathListFlag('ledger-export-root'),
    trashRetentionMs: numeric(process.env.OPENBOOK_TRASH_RETENTION_MS),
    trashCleanupIntervalMs: numeric(process.env.OPENBOOK_TRASH_CLEANUP_INTERVAL_MS),
  });

  console.log(`OpenBook server listening on ${running.url}`);
  // Machine-readable readiness line the desktop host parses from stdout.
  console.log(`OPENBOOK_READY ${running.url}`);

  // Idempotent: SIGINT/SIGTERM and the parent-death watches (stdin EOF + ppid
  // poll) can all fire — and race — for the same exit. The guard runs the
  // checkpoint + mirror drain + lock release exactly once.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void running
      .close()
      .catch((err) => console.error('OpenBook: error during shutdown:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Desktop sidecar only: also self-terminate if the host that spawned us dies
  // non-gracefully (Force Quit / crash / kill -9 / logout SIGKILL). Otherwise the
  // sidecar orphans, keeps the PGlite/mirror lock, and the next launch can't take
  // over (the lock correctly declines against a live owner). No-op for the
  // headless CLI and tests — see isSidecarMode().
  installSidecarParentDeath(shutdown);
}
