import {serve, getRequestListener} from '@hono/node-server';
import type {PGliteOptions} from '@electric-sql/pglite';
import {createApp, type AppWithCollab} from './app';
import {type Db, createPgliteDb, PostgresDb} from './db';
import {PageStore, PAGE_VERSION_KEEP, PAGE_VERSION_MAX_AGE_MS} from './store';
import {PageHub} from './hub';
import {BookMirror, MirrorLockedError, WriteBudgetError} from './mirror';
import {AiService} from './ai/service';
import {McpClientManager} from './ai/mcpClients';
import {AiUsageLog} from './ai/usage';
import {IdentityService} from './instanceConfig';
import {BackupScheduler} from './backups';
import {LedgerAutoExporter} from './ledgerAutoExport';
import {RosterSyncer, httpRosterFetcher, type RosterAssertionProvider} from './rosterSync';
import {isLoopbackHostname} from './hostGuard';
import {readFileSync, writeFileSync, rmSync, unlinkSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

export interface StartOptions {
  /** Connection string for an external Postgres (server mode). */
  databaseUrl?: string;
  /** Data directory for embedded PGlite (desktop mode). Required if no `databaseUrl`. */
  dataDir?: string;
  /**
   * PGlite WASM/data overrides. The compiled desktop sidecar passes embedded
   * assets here; under Node this is omitted and PGlite loads its own.
   */
  pgliteAssets?: Partial<PGliteOptions>;
  /**
   * Unix domain socket path to listen on (named pipe semantics on Windows). The
   * desktop's default transport: the webview reaches the server over this socket
   * via a host IPC bridge, so no TCP port is opened. May be combined with `port`
   * (the LAN bind added when publishing); when only `socketPath` is set, the
   * server is portless.
   */
  socketPath?: string;
  /** HTTP listen host. Defaults to `127.0.0.1`. */
  host?: string;
  /** HTTP listen port. Defaults to `4319`. */
  port?: number;
  /** Max Postgres connections (server mode only). Defaults to 10. */
  poolMax?: number;
  /**
   * How long a soft-deleted page stays in the trash before the cleanup job
   * purges it, in milliseconds. Defaults to 30 days. `0` purges on the next
   * sweep (no retention).
   */
  trashRetentionMs?: number;
  /**
   * How often the trash cleanup job runs, in milliseconds. Defaults to 1 hour.
   * `<= 0` disables the job (trash is kept until emptied manually). The same job
   * prunes the change-provenance edit log (see {@link editLogRetentionMs}).
   */
  trashCleanupIntervalMs?: number;
  /**
   * How long change-provenance entries (the `edit_log`, OB-165) are kept before
   * the cleanup job prunes them, in milliseconds. Defaults to 90 days; `<= 0`
   * keeps them forever. Bounds the log's growth so the embedded (autovacuum-less)
   * heap doesn't bloat (the OB-164 class of problem).
   */
  editLogRetentionMs?: number;
  /**
   * How long the idempotency ledgers (ER-6 `import_log`, ER-7 `write_keys`) are
   * kept before the cleanup job prunes them, in milliseconds. Defaults to 7 days;
   * `<= 0` keeps them forever. Doubles as the replay-dedup window: a re-applied
   * bundle / replayed create older than this is treated as new. Bounds the ledgers'
   * growth on the autovacuum-less embedded store (OB-164).
   */
  idempotencyRetentionMs?: number;
  /**
   * How many captured page versions (PVH-2) to keep per page before the cleanup
   * job prunes the oldest surplus. Defaults to {@link PAGE_VERSION_KEEP} (50). The
   * newest few are always retained even past {@link pageVersionMaxAgeMs}. Bounds
   * per-page history growth on the autovacuum-less embedded store (OB-164).
   */
  pageVersionKeep?: number;
  /**
   * How old a captured page version (PVH-2) may be before the cleanup job prunes
   * it, in milliseconds. Defaults to {@link PAGE_VERSION_MAX_AGE_MS} (90 days);
   * `<= 0` disables the age cut (keep-N still applies). A short rollback trail (the
   * newest few) survives regardless of age.
   */
  pageVersionMaxAgeMs?: number;
  /**
   * Embedded (PGlite) only: how often the maintenance job runs CHECKPOINT +
   * VACUUM (ANALYZE), in milliseconds. Defaults to 5 minutes; `<= 0` disables.
   * Overridable via `OPENBOOK_MAINTENANCE_INTERVAL_MS`. Ignored for external
   * Postgres, which has its own checkpointer + autovacuum. See {@link PageStore.maintain}.
   */
  maintenanceIntervalMs?: number;
  /**
   * Grace period, in milliseconds, before an unreferenced asset is eligible for
   * garbage collection (Assets A6). The maintenance job reaps only assets older
   * than this that NO live page's document references, so a just-uploaded asset
   * that hasn't been saved into a page yet is never reaped out from under a pending
   * save. Defaults to 24h; overridable via `OPENBOOK_ASSET_GC_GRACE_MS`. `<= 0`
   * reaps eligible orphans immediately (no grace). See {@link PageStore.gcUnreferencedAssets}.
   */
  assetGcGraceMs?: number;
  /**
   * Idle delay before the scheduled-backup catch-up check. Defaults to 15s.
   * Exposed for startup integration tests; production callers normally omit it.
   */
  backupCatchUpDelayMs?: number;
  /**
   * When set, mirror the library to a folder of HTML book files at this path
   * (one folder per book) in near-realtime, watch it for external edits, and
   * re-import changes (DB-wins on conflict). Off when unset. See {@link BookMirror}.
   */
  bookDir?: string;
  /**
   * Extra directories the ledger auto-export (LGR-7) may write into, on top of
   * `<dataDir>/exports`. Operator-supplied ONLY (CLI `--ledger-export-root`, env
   * `OPENBOOK_LEDGER_EXPORT_ROOTS`) — deliberately unreachable from the HTTP
   * surface, so no request can widen the fence its own target is checked
   * against. See {@link LedgerAutoExporter}.
   */
  ledgerExportRoots?: string[];
  /**
   * The viewer runtime bundle's JS source for the book mirror's
   * `_openbook/viewer.js` (see {@link BookMirror}'s `runtimeBundle`). The
   * compiled sidecar passes its embedded copy here; under Node it's resolved
   * from `OPENBOOK_VIEWER_BUNDLE` (a path) or the server package's staged
   * `assets/openbook-viewer.js`, and when none is available the mirror simply
   * writes the plain static files (no reference — graceful degradation).
   */
  viewerRuntime?: string;
  /**
   * When set, require this access token on every `/api/*` request (header or
   * `?token=`). Used when the desktop publishes its server on the LAN so the
   * unauthenticated library isn't open to anyone who can reach the port.
   */
  accessToken?: string;
  /**
   * Managed-library roster sync (OB-199; LIB-5 wire rename). Mints a FRESH signed
   * roster assertion per fetch for the bound library's `GET /api/libraries/:id/roster`
   * call. The signing happens HERE in the provider (the keychain-holding layer), so
   * the site private key never enters the data-server — the server only sees the
   * resulting bearer string. Preferred over {@link librarySyncToken}.
   *
   * DEFERRED desktop wiring (OB-199 follow-up): the desktop runs the data-server as
   * a separate sidecar process while the site key lives in the webview OS keychain,
   * so the provider must round-trip over IPC — a Tauri command (`ipc.rs`) the
   * sidecar's provider calls, handled in the webview by loading the keychain
   * identity and calling `signRosterAssertion({privateKey, publicKey, libraryId})`
   * from `@book.dev/sdk` (see `ForwardingProvider`, which already holds
   * `forwarding.keyStore`). Until that lands the provider is unset ⇒ no auth header.
   */
  rosterAssertionProvider?: RosterAssertionProvider;
  /**
   * Legacy/back-compat: a STATIC out-of-band bearer for the roster fetch (a
   * forwarding/site or device token), also read from `OPENBOOK_WORKSPACE_SYNC_TOKEN`
   * (env var name kept for back-compat). Superseded by {@link rosterAssertionProvider}
   * (which is fresh per fetch); used only when no provider is supplied. Absent + no
   * provider ⇒ the request is unauthenticated. The sync is inert unless a binding is
   * configured.
   */
  librarySyncToken?: string;
  /**
   * Server-authoritative Yjs persistence (Collab T9) — opt-in, default off. When
   * true, the server keeps a per-page canonical CRDT doc and persists the durable
   * snapshot from it, so a stale client can't overwrite newer content. Also enabled
   * by a truthy `OPENBOOK_SERVER_PERSIST`. Off ⇒ the shipped T3 client-saver model.
   */
  serverPersist?: boolean;
  /**
   * The per-run local-owner secret (the loopback-owner hatch). The desktop host
   * mints one at launch and passes it here via `OPENBOOK_LOCAL_OWNER_SECRET`; its
   * IPC bridge then stamps the matching `X-OpenBook-Local` header on exactly the
   * requests that originate in the app's own webview (never on tunnel-forwarded
   * traffic). A matching non-forwarded request holds machine-owner authority.
   * Unset ⇒ the hatch is inert (headless/server mode, tests).
   */
  localOwnerSecret?: string;
  /**
   * STAB-7 (LAN-hosted web UI): absolute path to a pre-built, client-only OpenBook
   * web bundle. When set, the sidecar ALSO serves that UI (see {@link AppOptions.uiDir})
   * so a LAN browser can open `http://<host>:<port>/` directly. Also read from
   * `OPENBOOK_UI_DIR`. Unset ⇒ API-only (a UI request 404s), the default. The
   * desktop wires this to its publish/LAN toggle; the served UI rides the existing
   * `guestAccess` policy unchanged.
   */
  uiDir?: string;
}

export interface RunningServer {
  /** Base URL clients connect to. */
  url: string;
  /** Bound `host:port`. */
  address: string;
  /** Stop the HTTP server and release the database. */
  close: () => Promise<void>;
}

type NodeServer = ReturnType<typeof serve>;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

/**
 * Loopback hosts safe to bind unclaimed — only the machine owner can reach them. Delegates
 * to {@link isLoopbackHostname} (hostGuard.ts) so the §2.6 bind backstop and the STAB-10
 * rebinding guard share ONE loopback host-set definition.
 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackHostname(host);
}

/**
 * The §2.6 boot backstop (B2). A reachable-but-unclaimed instance is rule-0
 * anonymous-world-writable; the exposure invariant forbids it. The publish/forward
 * FLOW requires a claim, but an operator hand-running the server bound to a
 * non-loopback interface *outside* that flow would slip past it — so the server
 * itself is the last line: refuse to bind beyond loopback while `ownerSubject` is
 * unset AND no `accessToken` gates reachability. Either an access token (a
 * reachability gate) or a claimed owner makes the bind safe; neither + a public
 * bind is the forbidden state, caught at boot rather than at the first anonymous
 * write. `allowOverride` (env `OPENBOOK_ALLOW_UNCLAIMED_EXPOSURE`) downgrades the
 * refusal to a loud warning — the spike's "refuse to start (or loudly warn)".
 */
export function assertExposureSafe(args: {
  host: string;
  hasAccessToken: boolean;
  ownerSubject: string | undefined;
  allowOverride?: boolean;
}): void {
  const {host, hasAccessToken, ownerSubject, allowOverride} = args;
  if (isLoopbackHost(host) || hasAccessToken || ownerSubject) return;
  const msg =
    `OpenBook refuses to bind to a non-loopback interface (${host}) while the instance is unclaimed ` +
    'and no accessToken is configured: it would be anonymous and world-writable on the network ' +
    '(OB-182 §2.6). Claim an owner, set an accessToken, or bind to loopback. Set ' +
    'OPENBOOK_ALLOW_UNCLAIMED_EXPOSURE=1 to override (NOT recommended).';
  if (allowOverride) {
    console.error(`WARNING: ${msg}`);
    return;
  }
  throw new Error(msg);
}
const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_EDIT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ASSET_GC_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Best-effort disk lookup of the viewer runtime bundle for the book mirror's
 * `_openbook/viewer.js`, used when {@link StartOptions.viewerRuntime} isn't
 * supplied (i.e. every mode but the compiled sidecar, which embeds its copy):
 *
 *  1. `OPENBOOK_VIEWER_BUNDLE` — an explicit path (ops/dev override);
 *  2. the server package's staged `assets/openbook-viewer.js` (build-sidecar.mjs
 *     stages it there from the ui build; a headless deployment can drop one in
 *     the same spot beside `dist/`).
 *
 * Returns `null` when neither yields bytes — the mirror then writes plain
 * static files with no runtime reference (the documented graceful fallback), so
 * a dev checkout that never built the ui works exactly as before.
 */
function resolveViewerRuntime(): string | null {
  const candidates: string[] = [];
  if (process.env.OPENBOOK_VIEWER_BUNDLE) candidates.push(process.env.OPENBOOK_VIEWER_BUNDLE);
  // dist/…js and src/server.ts are both one level below the package root.
  candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'openbook-viewer.js'));
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, 'utf8');
      if (text.length > 0) return text;
    } catch {
      // Missing/unreadable — try the next candidate.
    }
  }
  return null;
}

/**
 * Start the OpenBook server. The single entry both modes use:
 *  - **embedded** (desktop): no `databaseUrl` → open embedded PGlite under `dataDir`.
 *  - **server** (headless): `databaseUrl` → connect to external Postgres.
 *
 * Same store, migrations, and HTTP API either way.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  let db: Db;
  if (opts.databaseUrl) {
    db = new PostgresDb(opts.databaseUrl, {max: opts.poolMax});
  } else {
    if (!opts.dataDir) {
      throw new Error('startServer: provide either `databaseUrl` (server) or `dataDir` (embedded)');
    }
    db = await createPgliteDb(opts.dataDir, opts.pgliteAssets);
  }

  const store = new PageStore(db);
  await store.migrate();

  // Mint the stable per-library instance id (STAB-5) once, so `GET /api/instance`
  // can advertise it and an out-of-process MCP connector can verify it reached
  // THIS library rather than a foreign responder on the same loopback port.
  // Best-effort: a write failure here must never block startup.
  try {
    await store.ensureInstanceId();
  } catch (err) {
    console.error('OpenBook: could not mint the instance id:', err);
  }

  // Exposure backstop (OB-182 §2.6 B2): never bind beyond loopback while the
  // instance is unclaimed AND ungated by an accessToken. Evaluated before any
  // listener is created — and the store is closed on refusal so a rejected boot
  // releases its handle. The default loopback bind stays claim-free (back-compat).
  {
    const willBindTcp = opts.port != null || opts.host != null || !opts.socketPath;
    if (willBindTcp) {
      const {ownerSubject} = await store.getInstanceConfig();
      try {
        assertExposureSafe({
          host: opts.host ?? DEFAULT_HOST,
          hasAccessToken: !!opts.accessToken,
          ownerSubject,
          allowOverride: !!process.env.OPENBOOK_ALLOW_UNCLAIMED_EXPOSURE,
        });
      } catch (err) {
        await db.close();
        throw err;
      }
    }
  }

  // AI usage attribution (C1): the admin-only usage database (host page + database
  // + 30-day auto-expiry, on a `restricted` host so only owner/admin/ACL can read
  // it) is created LAZILY on the first attribution write — NOT at startup — so a
  // library that never uses AI keeps no usage page and a fresh library stays
  // empty. `load()` only re-adopts an already-created DB (from a prior run) so the
  // managed write-gate resolves immediately after a restart; it creates nothing.
  // Best-effort: a failed load/seed leaves the log inert, never blocking startup.
  const aiUsage = new AiUsageLog(store);
  await aiUsage.load();

  // Trash cleanup job: periodically purge pages whose `deleted_at` is older than
  // the retention window. Runs once on boot to catch up after downtime, then on
  // an interval. The timer is `unref`'d so it never keeps the process alive.
  const retentionMs = opts.trashRetentionMs ?? DEFAULT_TRASH_RETENTION_MS;
  const cleanupIntervalMs = opts.trashCleanupIntervalMs ?? DEFAULT_TRASH_CLEANUP_INTERVAL_MS;
  const editLogRetentionMs = opts.editLogRetentionMs ?? DEFAULT_EDIT_LOG_RETENTION_MS;
  const idempotencyRetentionMs = opts.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
  const pageVersionKeep = opts.pageVersionKeep ?? PAGE_VERSION_KEEP;
  const pageVersionMaxAgeMs = opts.pageVersionMaxAgeMs ?? PAGE_VERSION_MAX_AGE_MS;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  const sweepTrash = async (): Promise<void> => {
    try {
      const purged = await store.purgeExpired(retentionMs);
      if (purged > 0) console.log(`OpenBook trash cleanup: purged ${purged} expired page(s)`);
      // Prune the change-provenance log in the same sweep (OB-165) so it can't
      // grow unbounded on the autovacuum-less embedded store.
      const prunedEdits = await store.purgeOldEdits(editLogRetentionMs);
      if (prunedEdits > 0) console.log(`OpenBook edit-log cleanup: pruned ${prunedEdits} old entries`);
      // Prune the idempotency ledgers (ER-6 import_log / ER-7 write_keys) in the
      // same sweep — the retention doubles as the replay-dedup window.
      const prunedKeys = await store.purgeOldIdempotencyKeys(idempotencyRetentionMs);
      if (prunedKeys > 0) console.log(`OpenBook idempotency cleanup: pruned ${prunedKeys} old key(s)`);
      // Bound per-page version history (PVH-2) in the same sweep: keep-N + max-age,
      // off the hot save path (a per-save delete would only add write-amp on the
      // autovacuum-less embedded store, OB-164).
      const prunedVersions = await store.prunePageVersions(pageVersionKeep, pageVersionMaxAgeMs);
      if (prunedVersions > 0) console.log(`OpenBook page-version cleanup: pruned ${prunedVersions} old version(s)`);
      // Feature B: auto-expiry (TTL) — soft-delete rows older than each database's
      // configured window to the trash (restorable, not hard-deleted), where the
      // purge above eventually reaps them. No-op for databases without autoExpiry.
      const expiredRows = await store.sweepExpiredRows();
      if (expiredRows > 0) console.log(`OpenBook auto-expiry: trashed ${expiredRows} expired row(s)`);
    } catch (err) {
      console.error('OpenBook cleanup failed:', err);
    }
  };
  if (cleanupIntervalMs > 0) {
    await sweepTrash();
    cleanupTimer = setInterval(() => void sweepTrash(), cleanupIntervalMs);
    cleanupTimer.unref?.();
  }

  // PGlite self-maintenance job (embedded mode only). PGlite is single-process
  // WASM Postgres with no background checkpointer or autovacuum, so without this
  // the WAL grows unbounded — an unclean shutdown then leaves no valid checkpoint
  // and the next launch PANICs — and the `pages` heap bloats from save-on-edit
  // dead tuples (OB-164). Each tick runs CHECKPOINT + VACUUM (ANALYZE). External
  // Postgres maintains itself, so this is skipped there. The timer is `unref`'d
  // so it never keeps the process alive; `<= 0` (or the env override) disables it.
  const envMaintenance = process.env.OPENBOOK_MAINTENANCE_INTERVAL_MS;
  const maintenanceIntervalMs =
    opts.maintenanceIntervalMs ??
    (envMaintenance != null && envMaintenance.trim() !== '' && Number.isFinite(Number(envMaintenance))
      ? Number(envMaintenance)
      : DEFAULT_MAINTENANCE_INTERVAL_MS);
  const envAssetGcGrace = process.env.OPENBOOK_ASSET_GC_GRACE_MS;
  const assetGcGraceMs =
    opts.assetGcGraceMs ??
    (envAssetGcGrace != null && envAssetGcGrace.trim() !== '' && Number.isFinite(Number(envAssetGcGrace))
      ? Number(envAssetGcGrace)
      : DEFAULT_ASSET_GC_GRACE_MS);
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const runMaintenance = async (): Promise<void> => {
    try {
      await store.maintain();
      // Assets A6: reap assets that NO page document references (past the grace
      // period), alongside the WAL checkpoint + vacuum. Safe against the
      // stale-`asset_refs` hazard because eligibility is confirmed by scanning page
      // documents (live AND trashed, so a restore within trash retention can't
      // surface a broken image), not the ref table — see PageStore.gcUnreferencedAssets.
      const gc = await store.gcUnreferencedAssets({graceMs: assetGcGraceMs});
      if (gc.reaped > 0) {
        console.log(`OpenBook asset GC: reaped ${gc.reaped} unreferenced asset(s), ${gc.bytes} byte(s) reclaimed`);
      }
    } catch (err) {
      console.error('OpenBook PGlite maintenance failed:', err);
    }
  };
  if (!opts.databaseUrl && maintenanceIntervalMs > 0) {
    maintenanceTimer = setInterval(() => void runMaintenance(), maintenanceIntervalMs);
    maintenanceTimer.unref?.();
  }

  // Local-AI models live next to the data (desktop) or under the home dir
  // (server mode). The subsystem is inert until configured via /api/ai.
  const modelsDir = process.env.OPENBOOK_MODELS_DIR
    || (opts.dataDir ? path.join(opts.dataDir, 'models') : path.join(os.homedir(), '.openbook', 'models'));
  const ai = new AiService(db, modelsDir);
  // External-tools (MCP client) manager (AGENT-3): owned beside AiService, pools
  // connections to admin-registered MCP servers and hands the agent route
  // namespaced `mcp__*` tools. Inert until an admin configures + enables a server
  // (and the deployment hasn't set `OPENBOOK_MCP_CLIENTS=0`).
  const mcp = new McpClientManager(store);

  // Multi-user identity (OB-165): resolves a principal per request and enforces
  // the guest-access policy stored in settings. The default policy is
  // guest-write, so an instance with nobody signed in behaves exactly as before
  // — but every change is now attributed in the edit log, and the policy can be
  // tightened (read-only / off) by the owner.
  const identity = new IdentityService(store);

  // Scheduled backups (OB-166): tiered daily/weekly/monthly/yearly snapshots,
  // off by default until enabled in settings. Writes under the data dir
  // (embedded) or the home dir (headless server), unless the policy overrides
  // the folder. The timer is `unref`'d and a no-op while disabled.
  const defaultBackupDir = opts.dataDir
    ? path.join(opts.dataDir, 'backups')
    : path.join(os.homedir(), '.openbook', 'backups');
  const backups = new BackupScheduler(store, {
    defaultDir: defaultBackupDir,
    catchUpDelayMs: opts.backupCatchUpDelayMs,
  });

  // Ledger auto-export (LGR-7 insurance): when the owner sets
  // `ledgerAutoExportPath` in instance policy, every ledger mutation schedules
  // a debounced, atomic write of the canonical postings CSV to that path. Off
  // by default (unset path ⇒ every trigger is a silent no-op — a cheap config
  // read); the subscription itself costs nothing until the ledger mutates.
  //
  // The target is FENCED to these roots (S2): a DEDICATED `<dataDir>/exports`
  // subtree, plus whatever the operator allows out-of-band. Both sources are
  // process-level — no request can add a root — so the setting can never become
  // an arbitrary-file-write primitive. A headless server with no data dir gets
  // only the explicit roots (none ⇒ every path refused: fail closed).
  //
  // Deliberately NOT the data dir itself: that is the live PGlite directory, so
  // a default root of `dataDir` would let the export clobber the database it is
  // insuring (`<dataDir>/PG_VERSION` and friends). Created on demand so the
  // fence — which resolves each root through `realpath` — can see it.
  const ledgerDefaultExportDir = opts.dataDir ? path.join(opts.dataDir, 'exports') : undefined;
  if (ledgerDefaultExportDir) {
    try {
      mkdirSync(ledgerDefaultExportDir, {recursive: true});
    } catch {
      // Non-fatal: an uncreatable export dir simply matches no path (fail closed).
    }
  }
  const ledgerExportRoots = [
    ...(ledgerDefaultExportDir ? [ledgerDefaultExportDir] : []),
    ...(opts.ledgerExportRoots ?? []),
    ...(process.env.OPENBOOK_LEDGER_EXPORT_ROOTS ?? '')
      .split(path.delimiter)
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
  ];
  const ledgerAutoExport = new LedgerAutoExporter(store, {allowRoots: ledgerExportRoots});
  ledgerAutoExport.start();

  // Managed-library roster sync (OB-199; LIB-5): when this instance is bound to an
  // account library, periodically (+ on demand) pull that library's roster and
  // reconcile it into the local `members` table, so `members`-scope + admin/viewer
  // roles resolve for direct access too. Inert (a cheap config read) until a
  // binding is configured. Auth: prefer the injected assertion provider (mints a
  // fresh site-signed assertion per fetch in the keychain layer — the raw key never
  // reaches here); else fall back to a static out-of-band bearer; else no header.
  // `unref`'d.
  const syncToken = opts.librarySyncToken ?? process.env.OPENBOOK_WORKSPACE_SYNC_TOKEN;
  const assertionProvider: RosterAssertionProvider | undefined =
    opts.rosterAssertionProvider ?? (syncToken ? () => syncToken : undefined);
  const roster = new RosterSyncer(store, {
    fetchRoster: httpRosterFetcher({assertionProvider}),
  });
  roster.start();

  // Server-authoritative Yjs persistence (Collab T9) — opt-in, default off. Enabled
  // by the option or `OPENBOOK_SERVER_PERSIST` (truthy). When on, the server persists
  // the durable snapshot from its own canonical CRDT doc, removing the LWW window.
  const serverPersist =
    opts.serverPersist ?? /^(1|true|yes|on)$/i.test((process.env.OPENBOOK_SERVER_PERSIST ?? '').trim());

  // One hub is shared between the HTTP/SSE app and the disk mirror, so a
  // re-imported page fans out to every connected client too.
  const hub = new PageHub();
  const app = createApp(store, ai, hub, {
    accessToken: opts.accessToken,
    embedded: !opts.databaseUrl,
    identity,
    backups,
    roster,
    serverPersist,
    // C1: the AI usage-attribution log — routes log through it, and the database
    // write routes reject end-user edits to its managed database.
    aiUsage,
    // AGENT-3: the external-tools (MCP client) manager.
    mcp,
    // Loopback-owner hatch: the spawning host (the desktop app) shares its per-run
    // secret via env; a dev setup can export the same value to both processes.
    localOwnerSecret: opts.localOwnerSecret ?? process.env.OPENBOOK_LOCAL_OWNER_SECRET,
    // STAB-7: serve the LAN web UI from this dir when set (option or env). Unset ⇒
    // API-only. The desktop passes its bundled resource dir while sharing is on.
    uiDir: opts.uiDir ?? process.env.OPENBOOK_UI_DIR,
  });

  // The server can listen on a Unix domain socket (the desktop's portless IPC
  // default), a TCP port (headless, or the LAN bind added when publishing), or
  // both at once — the request handler is identical on every listener.
  const listener = getRequestListener(app.fetch);
  const closers: Array<() => Promise<void>> = [];
  let url = '';
  let address = '';
  let boundPort: number | null = null;

  if (opts.socketPath) {
    const socketPath = opts.socketPath;
    // A leftover socket file from a crash makes bind fail with EADDRINUSE.
    try {
      unlinkSync(socketPath);
    } catch {
      /* nothing stale to clear */
    }
    const udsServer = createServer(listener);
    await new Promise<void>((resolve, reject) => {
      udsServer.once('error', reject);
      udsServer.listen({path: socketPath}, () => resolve());
    });
    closers.push(() => new Promise<void>((r) => udsServer.close(() => r())));
    url = `unix:${socketPath}`;
    address = socketPath;
  }

  // Bind TCP when a port/host is explicitly requested (headless, or the publish
  // bind) or when there is no socket to serve over.
  if (opts.port != null || opts.host != null || !opts.socketPath) {
    const host = opts.host ?? DEFAULT_HOST;
    const port = opts.port ?? DEFAULT_PORT;
    let tcpServer!: NodeServer;
    const info = await new Promise<{port: number}>((resolve) => {
      tcpServer = serve({fetch: app.fetch, hostname: host, port}, (addr) => resolve(addr));
    });
    closers.push(() => new Promise<void>((r) => tcpServer.close(() => r())));
    boundPort = info.port;
    const clientHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    url = `http://${clientHost}:${info.port}`;
    address = `${host}:${info.port}`;
  }

  // BOOT-1: only arm the overdue catch-up after every requested listener has
  // completed its bind callback. `start()` merely schedules an unawaited idle
  // callback, so export work is never part of the boot-critical path.
  backups.start();

  // Advertise the bound TCP address (+ this process) for discovery and stale-lock
  // detection. Written under the data dir (embedded mode only) and removed on a
  // clean exit; a leftover file whose `pid` is dead marks a crashed prior run.
  // Portless (socket-only) runs write nothing — there is no TCP address to find.
  const infoFile = opts.dataDir && boundPort != null ? path.join(opts.dataDir, 'server.json') : null;
  if (infoFile) {
    try {
      writeFileSync(infoFile, JSON.stringify({url, port: boundPort, pid: process.pid, startedAt: new Date().toISOString()}));
    } catch (err) {
      console.error('OpenBook: could not write server.json discovery file:', err);
    }
  }

  // On-disk book-file mirror: write-through + watch + re-import (OB-134/135/136).
  let mirror: BookMirror | null = null;
  let mirrorUnsub: (() => void) | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.bookDir) {
    try {
      mirror = await BookMirror.create({
        store,
        dir: opts.bookDir,
        // Folder-level viewer runtime (`_openbook/viewer.js`): explicit override
        // (the sidecar's embedded copy) or the best-effort disk lookup; absent →
        // the mirror writes plain static files, exactly as before.
        runtimeBundle: opts.viewerRuntime ?? resolveViewerRuntime() ?? undefined,
        // A re-imported page must reach open clients, so publish it on the hub.
        onImported: async (page) => {
          hub.publishPage(page);
          hub.publishList(await store.listPages());
        },
        log: (m) => console.log(`[book-mirror] ${m}`),
      });
    } catch (err) {
      // Another live process already owns this book folder (OB-241): run without a
      // mirror rather than fight it. The owning process keeps the folder in sync.
      if (err instanceof MirrorLockedError) {
        console.warn(`OpenBook: ${err.message} — running without the on-disk mirror.`);
        mirror = null;
      } else if (err instanceof WriteBudgetError) {
        // A tight write budget (ER-2) tripped during the awaited bootstrap reconcile
        // (create → reconcileAll → flush). The mirror is a derived convenience, not
        // the canonical store, so a budget trip must degrade to running without it —
        // never crash startup. (The runaway it guards is still surfaced by the log.)
        console.warn(`OpenBook: ${err.message} — running without the on-disk mirror.`);
        mirror = null;
      } else {
        throw err;
      }
    }
  }
  if (mirror) {
    const m = mirror;
    const scheduleReconcile = (): void => {
      if (reconcileTimer) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void m.reconcileAll();
      }, 2000);
      reconcileTimer.unref?.();
    };
    // Fast path: a saved page is mirrored immediately. Structural changes
    // (deletes, moves, renames, row-property edits) ride a debounced reconcile,
    // which diffs every page's updatedAt against what's on disk.
    mirrorUnsub = hub.subscribeLive((event) => {
      if (event.type === 'page') m.enqueueWrite(event.page.id);
      else if (event.type === 'deleted') {
        m.enqueueDelete(event.id);
        scheduleReconcile();
      } else if (event.type === 'list') scheduleReconcile();
    });
  }

  return {
    url,
    address,
    close: async () => {
      await ai.dispose();
      await mcp.dispose();
      backups.stop();
      // Detach the ledger auto-export and let an in-flight write finish before
      // the store closes (a debounced-but-unfired export is dropped — the next
      // boot's first mutation re-exports). Never throws (errors are contained).
      ledgerAutoExport.stop();
      await ledgerAutoExport.flush();
      roster.stop();
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      // Stop accepting requests on every listener first, so no new writes arrive
      // mid-shutdown.
      for (const closeListener of closers) await closeListener();
      // Collab T9: checkpoint every dirty canonical doc before the store closes, so a
      // shutdown never strands an edit the server was the persistence authority for
      // (no-lost-edit-on-shutdown). Runs BEFORE the mirror unsubscribe/close below so
      // each checkpoint's publishPage still enqueues into the mirror journal. Off (and
      // a no-op) when server-persist is disabled. Best-effort — a flush failure must
      // not block the rest of shutdown.
      try {
        await (app as AppWithCollab).collabPersist?.flushAll();
      } catch (err) {
        console.error('OpenBook server-persist shutdown flush failed:', err);
      }
      // Flush-on-exit (OB-132): drain the mirror journal before the store closes,
      // so no committed write is lost. The mirror still needs the store to render.
      mirrorUnsub?.();
      if (mirror) await mirror.close();
      // Final WAL checkpoint before releasing the store (embedded mode only), so a
      // hard kill right after exit always finds a recent valid checkpoint to
      // recover from — the crash this guards (OB-164). External Postgres
      // checkpoints itself. Best-effort: a checkpoint failure must not block close.
      if (!opts.databaseUrl) {
        try {
          await store.checkpoint();
        } catch (err) {
          console.error('OpenBook shutdown checkpoint failed:', err);
        }
      }
      await store.close();
      if (infoFile) rmSync(infoFile, {force: true});
    },
  };
}
