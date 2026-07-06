/**
 * AI usage attribution (C1) — token + cost accounting for EVERY server-side
 * model request, logged into a server-managed, admin-only OpenBook database.
 *
 * Three moving parts live here:
 *
 *  1. {@link DEFAULT_PRICING} — the shipped per-provider+model list prices, plus
 *     an admin override persisted in the `settings` table under `aiPricing`. The
 *     effective price is `override → default → null` (an unknown model prices to
 *     null: tokens are still logged, `cost_usd` stays empty).
 *
 *  2. The usage database — an ordinary OpenBook database seeded once at startup on
 *     a `restricted` host page (owner/admin/ACL read only) and marked `managed` so
 *     the API rejects end-user writes. The server writes attribution rows straight
 *     through {@link PageStore.createRow}, bypassing the route gate.
 *
 *  3. {@link AiUsageLog.log} — snapshots `cost_usd` and the raw token counts into
 *     one row per model call, attributed to the SERVER-resolved principal.
 *
 * Everything is best-effort: a logging or seeding failure is caught and logged so
 * it can NEVER break the user's AI request. The provider API key is never written
 * to a row or a log line.
 */

import {
  emptyPageSnapshot,
  type AiModelPrice,
  type AiPricingResponse,
  type AiPricingTable,
  type AiProvider,
  type DatabaseProperty,
  type DatabaseSchema,
  type Principal,
} from '@book.dev/sdk';
import type {PageStore} from '../store';
import {AnthropicEngine, type TokenUsage} from './providers';

/** The settings key holding `{databaseId, hostPageId}` for the seeded usage DB. */
const USAGE_DB_KEY = 'aiUsageDb';
/** The settings key holding the admin pricing override table. */
const PRICING_KEY = 'aiPricing';

const USAGE_DB_TITLE = 'AI usage';
const DEFAULT_RETENTION_DAYS = 30;

/** Stable property ids for the seeded schema (referenced by {@link AiUsageLog.log}). */
const PROP = {
  time: 'p_time',
  user: 'p_user',
  provider: 'p_provider',
  model: 'p_model',
  input: 'p_input',
  output: 'p_output',
  cost: 'p_cost',
  kind: 'p_kind',
} as const;

/** The kinds of model call we attribute. */
export type UsageKind = 'agent' | 'complete' | 'generate';

/** One model call to attribute: what ran, how many tokens, and for whom. */
export interface UsageEvent {
  provider: AiProvider;
  model: string;
  kind: UsageKind;
  usage: TokenUsage;
  /** The SERVER-resolved request principal (never a client-supplied id). */
  principal: Principal;
}

/**
 * Shipped default pricing (US dollars per MILLION tokens), from current public
 * list prices. Claude cache read/write prices follow the standard 0.1× (read) and
 * 1.25× (5-minute write) of the input price. Common OpenAI models are included for
 * the `openai` provider when it points at api.openai.com; a local OpenAI-compatible
 * model that isn't in this table simply prices to null (unknown). Local providers
 * (`llama`/`mlx`/`mock`/`off`) are always free — see {@link AiUsageLog.priceFor}.
 */
export const DEFAULT_PRICING: AiPricingTable = {
  claude: {
    'claude-fable-5': {inputPerMtok: 10, outputPerMtok: 50, cacheReadPerMtok: 1, cacheWritePerMtok: 12.5},
    'claude-mythos-5': {inputPerMtok: 10, outputPerMtok: 50, cacheReadPerMtok: 1, cacheWritePerMtok: 12.5},
    'claude-opus-4-8': {inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25},
    'claude-opus-4-7': {inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25},
    'claude-opus-4-6': {inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25},
    'claude-opus-4-5': {inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25},
    'claude-sonnet-4-6': {inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75},
    'claude-sonnet-4-5': {inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75},
    'claude-haiku-4-5': {inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25},
  },
  openai: {
    'gpt-4o': {inputPerMtok: 2.5, outputPerMtok: 10},
    'gpt-4o-mini': {inputPerMtok: 0.15, outputPerMtok: 0.6},
    'gpt-4.1': {inputPerMtok: 2, outputPerMtok: 8},
    'gpt-4.1-mini': {inputPerMtok: 0.4, outputPerMtok: 1.6},
    'gpt-4.1-nano': {inputPerMtok: 0.1, outputPerMtok: 0.4},
    'gpt-4-turbo': {inputPerMtok: 10, outputPerMtok: 30},
    'gpt-3.5-turbo': {inputPerMtok: 0.5, outputPerMtok: 1.5},
    o1: {inputPerMtok: 15, outputPerMtok: 60},
    'o1-mini': {inputPerMtok: 1.1, outputPerMtok: 4.4},
    'o3-mini': {inputPerMtok: 1.1, outputPerMtok: 4.4},
  },
};

/** Local (always-free) providers — priced at 0 regardless of model. */
const FREE_PROVIDERS = new Set<AiProvider>(['off', 'mock', 'llama', 'mlx']);

/**
 * The server-managed AI usage log: seeds the admin-only usage database, prices
 * model calls, and writes one attribution row per call.
 */
export class AiUsageLog {
  private usageDbId: string | null = null;
  /** The usage DB's host page id — tracked so the generic page routes can guard it. */
  private hostPageId: string | null = null;
  private seeded = false;
  private seeding: Promise<void> | null = null;
  private override: AiPricingTable | null = null;

  constructor(private readonly store: PageStore) {}

  /** The seeded usage database id (once {@link ensureSeeded} has run), else null. */
  get databaseId(): string | null {
    return this.usageDbId;
  }

  /** The seeded usage DB's host page id (once {@link ensureSeeded} has run), else null. */
  get hostPage(): string | null {
    return this.hostPageId;
  }

  /** True for the server-managed usage database — the API write-gate for it. */
  isManagedDatabase(databaseId: string): boolean {
    return this.usageDbId !== null && databaseId === this.usageDbId;
  }

  /**
   * True for a page that belongs to the server-managed usage DB — its host page,
   * or any of its attribution rows (a row is a page tagged with the usage DB's
   * `database_id`). The API page-route write-gate keys off this so an owner/admin
   * can't delete rows, trash the host, un-restrict it, re-home it, or grant it an
   * ACL through the generic `/api/pages/*` routes (which the DB-route guard misses).
   * Server-internal store calls (the seed, attribution writes, the auto-expiry
   * sweep) never pass through here, so they stay unaffected.
   */
  async isManagedPage(pageId: string): Promise<boolean> {
    if (this.usageDbId === null) return false;
    if (this.hostPageId !== null && pageId === this.hostPageId) return true;
    const page = await this.store.getPage(pageId);
    return page?.databaseId === this.usageDbId;
  }

  /**
   * Idempotently create the usage database (host page + database + restricted
   * visibility + managed marker) and record its ids in `settings`. On a restart
   * the recorded ids are reused when still resolvable, so no duplicate DB appears.
   */
  async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    if (this.seeding) return this.seeding;
    this.seeding = this.doSeed().finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }

  private async doSeed(): Promise<void> {
    try {
      const recorded = await this.store.getSetting<{databaseId: string; hostPageId: string}>(USAGE_DB_KEY);
      if (recorded?.databaseId) {
        const db = await this.store.getDatabase(recorded.databaseId);
        if (db) {
          this.usageDbId = recorded.databaseId;
          this.hostPageId = recorded.hostPageId ?? null;
          this.seeded = true;
          return;
        }
        // Recorded but gone (purged externally): fall through and recreate.
      }
      const host = await this.store.upsertPage({name: USAGE_DB_TITLE, data: emptyPageSnapshot()});
      // Restrict the host BEFORE it hosts the database — so the usage DB's host page
      // is never briefly world-readable. (The seed also runs before the server binds
      // its listener, so there is no request-serving window either way.) Restricted ⇒
      // only owner / admin / ACL may read (see authorize()).
      await this.store.setPageVisibility(host.id, 'restricted');
      const database = await this.store.createDatabase({pageId: host.id, name: USAGE_DB_TITLE, schema: buildUsageSchema()});
      this.usageDbId = database.id;
      this.hostPageId = host.id;
      await this.store.setSetting(USAGE_DB_KEY, {databaseId: database.id, hostPageId: host.id});
      this.seeded = true;
    } catch (err) {
      // Never fatal: a failed seed just leaves the log inert (isManagedDatabase
      // false, log() a no-op) until the next attempt.
      console.error('AI usage database seed failed:', err);
    }
  }

  // ── Pricing ──────────────────────────────────────────────────────────────────

  private async loadOverride(): Promise<AiPricingTable> {
    if (this.override) return this.override;
    this.override = (await this.store.getSetting<AiPricingTable>(PRICING_KEY)) ?? {};
    return this.override;
  }

  /** The default + override + effective (merged) pricing tables. */
  async pricing(): Promise<AiPricingResponse> {
    const override = await this.loadOverride();
    return {default: DEFAULT_PRICING, override, effective: mergePricing(DEFAULT_PRICING, override)};
  }

  /**
   * Persist a new admin pricing override; returns the merged view. The incoming
   * table is SANITIZED first ({@link sanitizePricingOverride}): every model entry
   * must carry finite, non-negative `input`/`output` prices (optional `cache*`
   * prices likewise), else the entry is dropped — a bad admin PUT can never
   * snapshot a `NaN`/negative `cost_usd` onto a usage row.
   */
  async setPricingOverride(override: AiPricingTable): Promise<AiPricingResponse> {
    const clean = sanitizePricingOverride(override);
    await this.store.setSetting(PRICING_KEY, clean);
    this.override = clean;
    return {default: DEFAULT_PRICING, override: clean, effective: mergePricing(DEFAULT_PRICING, clean)};
  }

  /**
   * The effective price for a provider+model, or null for an unknown one. Local
   * providers are always {0, 0} (free), so a local call snapshots cost 0 (not null).
   */
  private priceFor(provider: AiProvider, model: string, effective: AiPricingTable): {inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number; cacheWritePerMtok?: number} | null {
    if (FREE_PROVIDERS.has(provider)) return {inputPerMtok: 0, outputPerMtok: 0};
    return effective[provider]?.[model] ?? null;
  }

  /**
   * Snapshot `cost_usd` for a call, or null when the model's price is unknown.
   * Cache tokens are folded in only when both captured AND priced.
   */
  private computeCost(provider: AiProvider, model: string, usage: TokenUsage, effective: AiPricingTable): number | null {
    const price = this.priceFor(provider, model, effective);
    if (!price) return null;
    let cost = (usage.inputTokens / 1_000_000) * price.inputPerMtok + (usage.outputTokens / 1_000_000) * price.outputPerMtok;
    if (usage.cacheReadTokens && price.cacheReadPerMtok !== undefined) {
      cost += (usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMtok;
    }
    if (usage.cacheWriteTokens && price.cacheWritePerMtok !== undefined) {
      cost += (usage.cacheWriteTokens / 1_000_000) * price.cacheWritePerMtok;
    }
    return cost;
  }

  // ── Retention (admin) ──────────────────────────────────────────────────────────

  /**
   * Update the usage database's auto-expiry window (admin retention control).
   * Clamps `days` to `[1, 365000]`; keeps the `created` basis and enabled flag.
   */
  async setRetentionDays(days: number): Promise<{days: number}> {
    await this.ensureSeeded();
    if (!this.usageDbId) throw new Error('the AI usage database is not available');
    const clamped = Math.min(365_000, Math.max(1, Math.floor(Number(days))));
    if (!Number.isFinite(clamped)) throw new Error('days must be a finite number');
    const db = await this.store.getDatabase(this.usageDbId);
    if (!db) throw new Error('the AI usage database is not available');
    const schema: DatabaseSchema = {...db.schema, autoExpiry: {enabled: true, days: clamped, basis: 'created'}};
    await this.store.updateDatabase(this.usageDbId, {schema});
    return {days: clamped};
  }

  // ── Write path ─────────────────────────────────────────────────────────────────

  /**
   * Log ONE usage row for a model call. Best-effort — any failure is swallowed
   * (logged server-side) so it can never break the user's AI request. Attribution
   * uses the passed (server-resolved) principal only; the API key is never written.
   */
  async log(event: UsageEvent): Promise<void> {
    try {
      await this.ensureSeeded();
      if (!this.usageDbId) return;
      const {effective} = await this.pricing();
      // A claude call with no configured model runs on the engine's default — price
      // (and log) against that so cost isn't spuriously null.
      const model = event.model || (event.provider === 'claude' ? AnthropicEngine.DEFAULT_MODEL : '');
      const cost = this.computeCost(event.provider, model, event.usage, effective);
      const properties: Record<string, unknown> = {
        [PROP.time]: new Date().toISOString(),
        [PROP.user]: formatUser(event.principal),
        [PROP.provider]: event.provider,
        [PROP.model]: model,
        [PROP.input]: event.usage.inputTokens,
        [PROP.output]: event.usage.outputTokens,
        [PROP.kind]: event.kind,
      };
      if (cost !== null) properties[PROP.cost] = cost;
      await this.store.createRow(this.usageDbId, {name: model || event.provider, properties}, event.principal);
    } catch (err) {
      console.error('AI usage attribution failed:', err);
    }
  }
}

/** `subject (name)` for the attribution `user` cell — never a client-supplied id. */
function formatUser(principal: Principal): string {
  const subject = principal.subject || principal.kind || 'unknown';
  return principal.name ? `${subject} (${principal.name})` : subject;
}

/**
 * Coerce one admin-supplied price to a finite, non-negative number, or null when
 * it is missing / non-numeric / negative (so it can never snapshot a bad cost).
 * A numeric string ("5") is coerced; anything else (NaN, Infinity, "abc", -1) is
 * rejected.
 */
function finitePrice(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Sanitize one model's price entry: both `inputPerMtok` and `outputPerMtok` are
 * required and must validate, else the whole entry is dropped (null). Optional
 * `cache*` prices are kept only when they validate.
 */
function sanitizePrice(raw: unknown): AiModelPrice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const inputPerMtok = finitePrice(r.inputPerMtok);
  const outputPerMtok = finitePrice(r.outputPerMtok);
  if (inputPerMtok === null || outputPerMtok === null) return null;
  const entry: AiModelPrice = {inputPerMtok, outputPerMtok};
  const cacheRead = finitePrice(r.cacheReadPerMtok);
  if (cacheRead !== null) entry.cacheReadPerMtok = cacheRead;
  const cacheWrite = finitePrice(r.cacheWritePerMtok);
  if (cacheWrite !== null) entry.cacheWritePerMtok = cacheWrite;
  return entry;
}

/**
 * Sanitize a whole admin pricing override: drop any provider/model whose price
 * entry doesn't validate to finite, non-negative numbers. The result is safe to
 * snapshot `cost_usd` from — a hostile/typo'd PUT can't inject `NaN`/negative
 * cost, and a provider with no valid model entries is omitted entirely.
 */
function sanitizePricingOverride(raw: unknown): AiPricingTable {
  if (!raw || typeof raw !== 'object') return {};
  const out: AiPricingTable = {};
  for (const [provider, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!models || typeof models !== 'object') continue;
    const cleanModels: Record<string, AiModelPrice> = {};
    for (const [model, price] of Object.entries(models as Record<string, unknown>)) {
      const entry = sanitizePrice(price);
      if (entry) cleanModels[model] = entry;
    }
    if (Object.keys(cleanModels).length > 0) out[provider as AiProvider] = cleanModels;
  }
  return out;
}

/** Merge an override table over the default (per provider → per model). */
function mergePricing(base: AiPricingTable, override: AiPricingTable): AiPricingTable {
  const out: AiPricingTable = {};
  const providers = new Set<AiProvider>([...Object.keys(base), ...Object.keys(override)] as AiProvider[]);
  for (const provider of providers) {
    out[provider] = {...(base[provider] ?? {}), ...(override[provider] ?? {})};
  }
  return out;
}

/** Build the seeded usage-database schema (reuses only existing property types). */
function buildUsageSchema(): DatabaseSchema {
  const selectOptions = (values: readonly string[]): DatabaseProperty['options'] =>
    values.map((v) => ({id: v, label: v.charAt(0).toUpperCase() + v.slice(1)}));
  const properties: DatabaseProperty[] = [
    {id: PROP.time, name: 'Time', type: 'date', includeTime: true},
    {id: PROP.user, name: 'User', type: 'text'},
    // provider/kind are closed sets ⇒ seed options (option id === stored value).
    {id: PROP.provider, name: 'Provider', type: 'select', options: selectOptions(['mock', 'llama', 'mlx', 'openai', 'claude'])},
    // model is open-ended ⇒ a select with no seeded options; the raw model string
    // is stored as the cell value.
    {id: PROP.model, name: 'Model', type: 'select'},
    {id: PROP.input, name: 'Input tokens', type: 'number'},
    {id: PROP.output, name: 'Output tokens', type: 'number'},
    {id: PROP.cost, name: 'Cost', type: 'number', numberFormat: 'dollar'},
    {id: PROP.kind, name: 'Kind', type: 'select', options: selectOptions(['agent', 'complete', 'generate'])},
  ];
  return {
    properties,
    views: [
      {
        id: 'v_usage',
        name: 'Usage',
        type: 'table',
        filters: [],
        sorts: [{propertyId: PROP.time, direction: 'desc'}],
        visiblePropertyIds: [PROP.time, PROP.user, PROP.provider, PROP.model, PROP.input, PROP.output, PROP.cost, PROP.kind],
      },
    ],
    // 30-day retention (feature B) — soft-deletes old rows to the trash on the hourly sweep.
    autoExpiry: {enabled: true, days: DEFAULT_RETENTION_DAYS, basis: 'created'},
    // Read-only marker for the UI; the authoritative write-gate keys off the id above.
    managed: true,
  };
}
