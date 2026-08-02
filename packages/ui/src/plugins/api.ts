import React from 'react';
import type {
  DataClient,
  DatabaseRow,
  LedgerAccount,
  LedgerAccountInput,
  LedgerAccountPatch,
  LedgerClearedState,
  LedgerDraftInput,
  LedgerDraftPatch,
  LedgerInfo,
  LedgerPeriod,
  LedgerPeriodCloseInput,
  LedgerPeriodCloseResult,
  LedgerPeriodReopenResult,
  LedgerPosting,
  LedgerReconciliation,
  LedgerReconciliationInput,
  LedgerReconciliationPatch,
  LedgerReconciliationStatus,
  LedgerReconciliationSummary,
  LedgerReverseOptions,
  LedgerTransaction,
  LedgerTransactionState,
  LedgerVerifyReport,
  PageMeta,
  StoredDatabase,
  StoredPage,
} from '@book.dev/sdk';
import {
  CsvLimitError,
  LEDGER_MAX_TRANSACTION_LIMIT,
  LedgerError,
  closedPeriodContaining,
  closedPeriodsOverlapping,
  MoneyCurrencyError,
  MoneyError,
  MoneyParseError,
  MoneyRangeError,
  compareAmounts,
  formatAmount,
  isValidMinor,
  negateAmount,
  parseAmount,
  parseCsv,
  sumAmounts,
  textSnapshot,
} from '@book.dev/sdk';
import {registerCustomBlock, type CustomBlockDef} from '../blockeditor/registry';
import {registerPluginCommand, type PluginCommand} from './commandRegistry';

/**
 * The API handed to a plugin's `activate(api)` — the whole contract between
 * a plugin and the app. Everything registered through it is tracked, so
 * disabling or removing the plugin tears its contributions down cleanly.
 *
 * Plugins import this module as `@book.dev/plugin-sdk` (and React as
 * `react`); both resolve to host instances, never bundled copies.
 */

export interface PluginBlockDef {
  /** Block type, namespaced automatically as `<pluginId>/<type>`. */
  type: string;
  render: CustomBlockDef['render'];
  slash?: CustomBlockDef['slash'];
}

export interface PluginCommandDef {
  id: string;
  title: string;
  keywords?: string;
  run: () => void;
}

export interface PluginApi {
  /** The plugin's own manifest (id, name, version…). */
  manifest: {id: string; name: string; version: string};
  /** Register a custom block (renders in documents; optional slash entry). */
  blocks: {register(def: PluginBlockDef): void};
  /** Register a command-palette command. */
  commands: {register(def: PluginCommandDef): void};
  /** Read and write library pages (integration surface). */
  pages: {
    list(): Promise<PageMeta[]>;
    get(id: string): Promise<StoredPage | null>;
    create(name: string, markdownish?: string): Promise<StoredPage>;
  };
  /**
   * Typed, read-only access to library databases. Same ambient user
   * credentials — and thus the same read gates — as `pages.*` and `fetch`
   * already carry: this adds types over what a plugin could always reach by
   * hand-rolling `api.fetch` calls, never new privilege. Deliberately no row
   * or schema writes in this surface (deferred until a capability/permission
   * model exists).
   */
  databases: {
    /** A database by id (schema is a typed `DatabaseSchema`), or `null`. */
    get(databaseId: string): Promise<StoredDatabase | null>;
    /** The database hosted by a page, or `null` if the page hosts none. */
    getByPage(pageId: string): Promise<StoredDatabase | null>;
    /** A database's rows, projected (properties + exported cell values). */
    listRows(databaseId: string): Promise<DatabaseRow[]>;
    /**
     * Live row-list updates. Returns an unsubscribe fn; the host ALSO tears
     * the subscription down automatically when the plugin is disabled,
     * removed, or reloaded — no leaked event-stream handlers.
     */
    subscribeRows(databaseId: string, onRows: (rows: DatabaseRow[]) => void): () => void;
  };
  /**
   * The double-entry ledger (LGR-3), typed end-to-end. Thin delegation over
   * the ambient-credentialed DataClient's ledger ops — same trust model as
   * `databases.*`: types over what `api.fetch('/api/ledger/…')` could always
   * reach, never new privilege. Invariant violations reject with a typed
   * {@link LedgerError} (also exported from `@book.dev/plugin-sdk` so plugins
   * can `instanceof`-match). Amounts are SIGNED INTEGER MINOR UNITS
   * everywhere (LGR-2): parse user input with `parseAmount`, render with
   * `formatAmount` — both exported from `@book.dev/plugin-sdk`.
   *
   * No subscriptions live on this surface; for live account/transaction
   * updates subscribe to the seeded databases (`info().databases.*`) via
   * `databases.subscribeRows`, which is already disposable-tracked.
   */
  ledger: {
    /** Whether the ledger is initialized, and the seeded database/host ids. */
    info(): Promise<LedgerInfo>;
    /** Seed the four managed ledger databases + host page (idempotent). */
    init(): Promise<LedgerInfo>;
    listAccounts(): Promise<LedgerAccount[]>;
    createAccount(input: LedgerAccountInput): Promise<LedgerAccount>;
    getAccount(id: string): Promise<LedgerAccount | null>;
    updateAccount(id: string, patch: LedgerAccountPatch): Promise<LedgerAccount>;
    listTransactions(opts?: {state?: LedgerTransactionState; limit?: number}): Promise<LedgerTransaction[]>;
    getTransaction(id: string): Promise<LedgerTransaction | null>;
    /** Create a DRAFT journal entry (amounts validated already at draft time). */
    createDraft(input: LedgerDraftInput): Promise<LedgerTransaction>;
    updateDraft(id: string, patch: LedgerDraftPatch): Promise<LedgerTransaction>;
    deleteDraft(id: string): Promise<boolean>;
    /** Post a draft atomically (balance + accounts enforced server-side). */
    post(id: string): Promise<LedgerTransaction>;
    reverse(id: string, opts?: LedgerReverseOptions): Promise<LedgerTransaction>;
    setPostingCleared(postingId: string, cleared: LedgerClearedState): Promise<LedgerPosting>;
    /**
     * Statement reconciliation (LGR-11) — matching an account's postings to a
     * bank statement until the difference is exactly zero, and freezing them
     * when it is. `finishReconciliation` rejects `reconciliation-unbalanced` at
     * any other difference: the rule is enforced in the store, so a block that
     * forgot to disable its own button still cannot finish a broken match.
     */
    listReconciliations(opts?: {accountId?: string; status?: LedgerReconciliationStatus}): Promise<LedgerReconciliation[]>;
    /** One reconciliation with its live cleared balance + difference, or `null`. */
    getReconciliation(id: string): Promise<LedgerReconciliationSummary | null>;
    startReconciliation(input: LedgerReconciliationInput): Promise<LedgerReconciliation>;
    /**
     * AMEND an OPEN reconciliation's statement date/balance (LGR-22), and
     * ABANDON one outright. Together these are the way back from a mistyped
     * closing balance, which is otherwise unrecoverable: a wrong target can
     * never reach a zero difference, so `finishReconciliation` is out of reach,
     * `reopenReconciliation` applies only to a finished one, and
     * `startReconciliation` refuses a second open one on the account. Neither
     * call touches a posting's cleared state.
     */
    amendReconciliation(id: string, patch: LedgerReconciliationPatch): Promise<LedgerReconciliationSummary>;
    abandonReconciliation(id: string): Promise<LedgerReconciliation>;
    /** Tick (`cleared`) or untick (`pending`) one posting inside an OPEN one. */
    toggleReconciliationPosting(id: string, postingId: string, cleared: 'pending' | 'cleared'): Promise<LedgerReconciliationSummary>;
    finishReconciliation(id: string): Promise<LedgerReconciliationSummary>;
    reopenReconciliation(id: string): Promise<LedgerReconciliationSummary>;
    /**
     * Accounting periods (LGR-12). `closePeriod` posts the closing entry
     * (income-statement accounts → retained earnings) and LOCKS the range —
     * the store rejects `period-closed` for any posting/reversal dated inside
     * it, so a block that forgot to disable its own button still cannot write
     * into a closed period. Open reconciliations WARN in the result and never
     * block. `reopenPeriod` is the explicit, audited inverse: it voids the
     * closing entry via a reversal and restores postability.
     */
    listPeriods(): Promise<LedgerPeriod[]>;
    closePeriod(input: LedgerPeriodCloseInput): Promise<LedgerPeriodCloseResult>;
    reopenPeriod(id: string): Promise<LedgerPeriodReopenResult>;
    /**
     * The whole ledger as a Beancount journal (LGR-13) — byte-stable text,
     * verifiable by `bean-check`/Fava. A read, gated exactly like the other
     * ledger reads.
     */
    exportBeancount(): Promise<string>;
    /**
     * The independent invariant verifier's report (LGR-7). Admin-gated over
     * HTTP (the report names entity ids across the whole book) — a non-admin
     * caller's promise REJECTS; the in-browser local store answers directly.
     */
    verify(): Promise<LedgerVerifyReport>;
  };
  /**
   * The content-addressed binary asset store (same ambient credentials/read
   * gates as everything above). Asset ids ARE the SHA-256 hash of the bytes:
   * a byte-identical `put` dedups to the same id, and `get` answers `null`
   * for missing and unreadable alike.
   */
  assets: {
    /** Bytes + mime by content-hash id, or `null` (missing or unreadable). */
    get(id: string): Promise<{bytes: Uint8Array; mime: string} | null>;
    /**
     * Upload bytes ref'd to `pageId` (a page the user can write, whose read
     * gate the asset inherits). Resolves the content-hash `{id}`.
     */
    put(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}>;
  };
  /** Plugin-scoped persistent key-value storage (per browser profile). */
  storage: {get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void};
  /** Network access for integrations (plain fetch — same trust as live code). */
  fetch: typeof fetch;
}

/** What `activate` may hand back (everything optional). */
export interface PluginActivationResult {
  deactivate?: () => void;
}

export type PluginModule = {
  default?: (api: PluginApi) => PluginActivationResult | void;
  activate?: (api: PluginApi) => PluginActivationResult | void;
};

/**
 * Build a plugin's API instance; `track` receives every teardown. The host's
 * tracker also handles registrations made after dispose (it tears them down
 * immediately instead of leaking them).
 */
export function buildPluginApi(
  manifest: {id: string; name: string; version: string},
  client: DataClient,
  track: (d: () => void) => void,
): PluginApi {
  const storagePrefix = `openbook.plugin.${manifest.id}.`;
  return {
    manifest: {id: manifest.id, name: manifest.name, version: manifest.version},
    blocks: {
      register(def: PluginBlockDef): void {
        track(
          registerCustomBlock({
            type: `${manifest.id}/${def.type}`,
            render: def.render,
            slash: def.slash,
          }),
        );
      },
    },
    commands: {
      register(def: PluginCommandDef): void {
        const command: PluginCommand = {
          id: `${manifest.id}/${def.id}`,
          title: def.title,
          keywords: def.keywords ?? '',
          run: def.run,
          pluginId: manifest.id,
        };
        track(registerPluginCommand(command));
      },
    },
    pages: {
      list: () => client.listPages(),
      get: (id) => client.getPage(id),
      create: (name, text) =>
        // Emit a block-native `blockdoc` from birth (never a legacy no-blockdoc
        // page); the block editor loads it without the migrate-on-open path.
        client.savePage({name, data: textSnapshot(text ?? '', 'pl')}),
    },
    databases: {
      get: (databaseId) => client.getDatabase(databaseId),
      getByPage: (pageId) => client.getPageDatabase(pageId),
      listRows: (databaseId) => client.listRows(databaseId),
      subscribeRows(databaseId, onRows): () => void {
        const stop = client.subscribeRows(databaseId, onRows);
        // Idempotent wrapper: the plugin may unsubscribe manually AND the
        // host disposes on deactivate/reload — the second call must be a
        // no-op, never a double-teardown.
        let done = false;
        const unsubscribe = (): void => {
          if (done) return;
          done = true;
          stop();
        };
        track(unsubscribe);
        return unsubscribe;
      },
    },
    ledger: {
      info: () => client.ledgerInfo(),
      init: () => client.ledgerInit(),
      listAccounts: () => client.ledgerListAccounts(),
      createAccount: (input) => client.ledgerCreateAccount(input),
      getAccount: (id) => client.ledgerGetAccount(id),
      updateAccount: (id, patch) => client.ledgerUpdateAccount(id, patch),
      listTransactions: (opts) => client.ledgerListTransactions(opts),
      getTransaction: (id) => client.ledgerGetTransaction(id),
      createDraft: (input) => client.ledgerCreateDraft(input),
      updateDraft: (id, patch) => client.ledgerUpdateDraft(id, patch),
      deleteDraft: (id) => client.ledgerDeleteDraft(id),
      post: (id) => client.ledgerPostTransaction(id),
      reverse: (id, opts) => client.ledgerReverseTransaction(id, opts),
      setPostingCleared: (postingId, cleared) => client.ledgerSetPostingCleared(postingId, cleared),
      listReconciliations: (opts) => client.ledgerListReconciliations(opts),
      getReconciliation: (id) => client.ledgerGetReconciliation(id),
      startReconciliation: (input) => client.ledgerStartReconciliation(input),
      amendReconciliation: (id, patch) => client.ledgerAmendReconciliation(id, patch),
      abandonReconciliation: (id) => client.ledgerAbandonReconciliation(id),
      toggleReconciliationPosting: (id, postingId, cleared) => client.ledgerToggleReconciliationPosting(id, postingId, cleared),
      finishReconciliation: (id) => client.ledgerFinishReconciliation(id),
      reopenReconciliation: (id) => client.ledgerReopenReconciliation(id),
      listPeriods: () => client.ledgerListPeriods(),
      closePeriod: (input) => client.ledgerClosePeriod(input),
      reopenPeriod: (id) => client.ledgerReopenPeriod(id),
      exportBeancount: () => client.ledgerExportBeancount(),
      verify: () => client.ledgerVerify(),
    },
    assets: {
      get: (id) => client.getAsset(id),
      put: (bytes, mime, pageId) => client.putAsset(bytes, mime, pageId),
    },
    storage: {
      get<T>(key: string): T | undefined {
        try {
          const raw = localStorage.getItem(storagePrefix + key);
          return raw === null ? undefined : (JSON.parse(raw) as T);
        } catch {
          return undefined;
        }
      },
      set(key: string, value: unknown): void {
        try {
          localStorage.setItem(storagePrefix + key, JSON.stringify(value));
        } catch {
          // quota/private mode — plugin storage is best-effort
        }
      },
    },
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  };
}

/**
 * Host modules importable from plugin code. Besides the per-plugin `api`,
 * `@book.dev/plugin-sdk` exposes the money core (LGR-2) and the typed
 * {@link LedgerError}, the ledger's read bounds, and the shared RFC-4180
 * {@link parseCsv}: pure helpers/classes/constants a ledger-touching plugin
 * MUST share with the host — user amount input is only ever parsed by
 * `parseAmount`, a plugin can only `instanceof`-match the host's error class
 * (not a bundled copy), and a plugin that ships its own CSV reader ships its
 * own quoting bugs.
 */
export const hostModulesFor = (api: PluginApi): Record<string, unknown> => ({
  react: React,
  '@book.dev/plugin-sdk': {
    api,
    parseAmount,
    formatAmount,
    sumAmounts,
    negateAmount,
    // Ordering/equality on money. A plugin that compares two amounts otherwise
    // reaches for `===` or `<`, which is arithmetic on money by another name and
    // is exactly what the rest of this surface exists to keep out of plugins.
    compareAmounts,
    isValidMinor,
    MoneyError,
    MoneyParseError,
    MoneyRangeError,
    MoneyCurrencyError,
    LedgerError,
    // The server's transaction-page cap. A plugin that TOTALS what it fetched
    // (a report) must be able to tell a full page from a complete book, and a
    // hard-coded copy would rot silently the day the cap changed.
    LEDGER_MAX_TRANSACTION_LIMIT,
    // LGR-12: THE period predicates — the same pure functions the store's
    // date-lock guard runs. A plugin that re-derived "is this date closed"
    // would be the two-copies-of-one-fact defect this epic keeps fixing.
    closedPeriodContaining,
    closedPeriodsOverlapping,
    parseCsv,
    CsvLimitError,
  },
});
