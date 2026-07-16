import {useCallback, useEffect, useMemo, useState} from 'react';
import {Loader2} from 'lucide-react';
import type {AiModelPrice, AiPricingResponse, AiPricingTable, AiProvider, AiUsageResponse} from '@book.dev/sdk';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {SettingsSection} from '@/components/settings/primitives';
import {isAdminRole, isForbidden} from '@/components/settings/adminGate';
import {cn} from '@/lib/utils';

/**
 * The admin-only AI usage surface (C2): a recent-usage viewer with totals, an
 * editable per-model pricing table (drives the `cost_usd` snapshot), and the
 * usage database's retention window. Embedded at the foot of the AI settings
 * tab and RENDERS NOTHING for a non-admin — the whole surface is gated on the
 * effective instance role AND re-gated by a 403 from the admin-only endpoints
 * (the MembersSettings hide-not-break pattern), so a viewer / guest sees none of
 * it. The server's `requireInstanceAdmin` stays the sole enforcement; this gate
 * only decides visibility.
 */

/** Rows of the editable pricing table, keyed by provider then model. */
type PriceDraft = Record<string, Record<string, {input: string; output: string}>>;

/** Seed the editable draft (strings, for the inputs) from the effective table. */
function draftFrom(effective: AiPricingTable): PriceDraft {
  const draft: PriceDraft = {};
  for (const [provider, models] of Object.entries(effective)) {
    if (!models) continue;
    draft[provider] = {};
    for (const [model, price] of Object.entries(models)) {
      draft[provider][model] = {input: String(price.inputPerMtok), output: String(price.outputPerMtok)};
    }
  }
  return draft;
}

/** Parse a numeric field to a finite, non-negative number, or null if invalid. */
function parsePrice(raw: string): number | null {
  const n = raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build the minimal override to persist: only models whose edited input/output
 * differ from the shipped default are kept (so an unchanged row falls back to the
 * default, and a future default price update still applies). Any `cache*` prices
 * on the effective entry are carried through so an override doesn't drop them.
 */
function buildOverride(draft: PriceDraft, defaults: AiPricingTable, effective: AiPricingTable): AiPricingTable {
  const out: AiPricingTable = {};
  for (const [provider, models] of Object.entries(draft)) {
    const clean: Record<string, AiModelPrice> = {};
    for (const [model, entry] of Object.entries(models)) {
      const input = parsePrice(entry.input);
      const output = parsePrice(entry.output);
      // Empty or invalid → drop this model from the override so it falls back to
      // the shipped default (NOT the prior override): clearing a field restores it.
      if (input === null || output === null) continue;
      const def = defaults[provider as AiProvider]?.[model];
      const differs = !def || def.inputPerMtok !== input || def.outputPerMtok !== output;
      if (!differs) continue;
      const eff = effective[provider as AiProvider]?.[model];
      const price: AiModelPrice = {inputPerMtok: input, outputPerMtok: output};
      if (eff?.cacheReadPerMtok !== undefined) price.cacheReadPerMtok = eff.cacheReadPerMtok;
      if (eff?.cacheWritePerMtok !== undefined) price.cacheWritePerMtok = eff.cacheWritePerMtok;
      clean[model] = price;
    }
    if (Object.keys(clean).length > 0) out[provider as AiProvider] = clean;
  }
  return out;
}

const num = (n: number): string => n.toLocaleString();
/** Per-row cost — 4dp so a sub-cent Haiku call doesn't round to `$0.00`. */
const money = (n: number): string => `$${n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4})}`;
/** Summary total — 2dp (the aggregate is well above the sub-cent noise floor). */
const money2 = (n: number): string => `$${n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

export default function AiUsageSettings() {
  const client = useData();
  const {t} = useTranslation();

  const [gate, setGate] = useState<'loading' | 'hidden' | 'ready'>('loading');
  const [pricing, setPricing] = useState<AiPricingResponse | null>(null);
  const [usage, setUsage] = useState<AiUsageResponse | null>(null);
  const [draft, setDraft] = useState<PriceDraft>({});
  const [savingPrice, setSavingPrice] = useState(false);
  const [priceSaved, setPriceSaved] = useState(false);

  const [retention, setRetention] = useState('30');
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionSaved, setRetentionSaved] = useState(false);

  const load = useCallback(async () => {
    // Fast path: on a CLAIMED instance a non-admin is hidden without pinging the
    // admin endpoints. On an UNCLAIMED (single-user) instance the writer IS the
    // admin-equivalent — the server's `requireInstanceAdmin` falls back to the
    // create gate — so fall through to the endpoint probe, whose 403 is the
    // authoritative refusal. A probe failure is likewise inconclusive.
    try {
      const info = await client.getInstanceInfo();
      if (info.ownerSubject && !isAdminRole(info)) {
        setGate('hidden');
        return;
      }
    } catch {
      /* inconclusive — the endpoint 403 below decides */
    }
    try {
      const [p, u] = await Promise.all([client.getAiPricing(), client.getAiUsage()]);
      setPricing(p);
      setDraft(draftFrom(p.effective));
      setUsage(u);
      setRetention(String(u.retentionDays ?? 30));
      setGate('ready');
    } catch (e) {
      // 403 = not an admin; any other failure hides too (the surface is optional
      // and must never leak to a non-admin on a weird error).
      if (!isForbidden(e)) console.debug('AI usage viewer unavailable:', e);
      setGate('hidden');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const setPrice = useCallback((provider: string, model: string, field: 'input' | 'output', value: string) => {
    setPriceSaved(false);
    setDraft((d) => ({...d, [provider]: {...d[provider], [model]: {...d[provider][model], [field]: value}}}));
  }, []);

  const savePricing = useCallback(async () => {
    if (!pricing) return;
    setSavingPrice(true);
    setPriceSaved(false);
    try {
      const override = buildOverride(draft, pricing.default, pricing.effective);
      const next = await client.setAiPricing(override);
      setPricing(next);
      setDraft(draftFrom(next.effective));
      setPriceSaved(true);
    } finally {
      setSavingPrice(false);
    }
  }, [client, draft, pricing]);

  const saveRetention = useCallback(async () => {
    const days = Number(retention);
    if (!Number.isFinite(days) || days < 1) return;
    setSavingRetention(true);
    setRetentionSaved(false);
    try {
      const {days: applied} = await client.setAiUsageRetention(Math.floor(days));
      setRetention(String(applied));
      setRetentionSaved(true);
      // Retention edits seed the usage DB server-side — refresh the viewer so a
      // just-created DB stops reporting the empty state.
      try {
        setUsage(await client.getAiUsage());
      } catch {
        /* keep the current view */
      }
    } finally {
      setSavingRetention(false);
    }
  }, [client, retention]);

  const providers = useMemo(() => (pricing ? Object.keys(pricing.effective) : []), [pricing]);

  if (gate !== 'ready' || !pricing) return null;

  const totals = usage?.totals;
  const rows = usage?.rows ?? [];

  return (
    <div className="flex flex-col gap-7" data-testid="ai-usage-admin">
      {/* ── Usage viewer ─────────────────────────────────────────────────── */}
      <SettingsSection title={t('aiUsage.usageTitle')} description={t('aiUsage.usageHint')}>
        {!usage?.exists || rows.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground">
            {t('aiUsage.empty')}
          </p>
        ) : (
          <>
            {totals && (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryStat label={t('aiUsage.totalCalls')} value={num(totals.rows)} />
                <SummaryStat label={t('aiUsage.totalInput')} value={num(totals.inputTokens)} />
                <SummaryStat label={t('aiUsage.totalOutput')} value={num(totals.outputTokens)} />
                <SummaryStat label={t('aiUsage.totalCost')} value={money2(totals.cost)} />
              </dl>
            )}
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-xs" aria-label={t('aiUsage.tableLabel')}>
                <thead className="border-b border-border bg-muted/40 text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">{t('aiUsage.colTime')}</th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">{t('aiUsage.colUser')}</th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">{t('aiUsage.colModel')}</th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('aiUsage.colInput')}</th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('aiUsage.colOutput')}</th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('aiUsage.colCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60 last:border-b-0">
                      <td className="whitespace-nowrap px-2.5 py-1.5 text-muted-foreground">
                        {r.time ? new Date(r.time).toLocaleString() : '—'}
                      </td>
                      <td className="max-w-[200px] truncate px-2.5 py-1.5" title={r.user}>{r.user || '—'}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">
                        <span className="font-mono">{r.model || r.provider}</span>
                        <span className="ml-1.5 text-muted-foreground">{r.provider}</span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.inputTokens)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{num(r.outputTokens)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{r.cost === null ? '—' : money(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totals && totals.rows > rows.length && (
              <p className="text-xs text-muted-foreground">
                {t('aiUsage.shownOfTotal', {shown: num(rows.length), total: num(totals.rows)})}
              </p>
            )}
          </>
        )}
      </SettingsSection>

      {/* ── Pricing editor ───────────────────────────────────────────────── */}
      <SettingsSection title={t('aiUsage.pricingTitle')} description={t('aiUsage.pricingHint')}>
        <div className="flex flex-col gap-4">
          {providers.map((provider) => {
            const models = pricing.effective[provider as AiProvider] ?? {};
            const modelIds = Object.keys(models);
            if (modelIds.length === 0) return null;
            return (
              <div key={provider} className="flex flex-col gap-1.5">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`ai.providerShort.${provider}` as Parameters<typeof t>[0])}
                </h5>
                <div className="flex flex-col gap-1 rounded-md border border-border p-2">
                  <div className="grid grid-cols-[1fr_7rem_7rem] items-center gap-2 px-1 pb-1 text-[11px] font-medium text-muted-foreground">
                    <span>{t('aiUsage.colModel')}</span>
                    <span className="text-right">{t('aiUsage.inputPerMtok')}</span>
                    <span className="text-right">{t('aiUsage.outputPerMtok')}</span>
                  </div>
                  {modelIds.map((model) => {
                    const inId = `price-${provider}-${model}-in`;
                    const outId = `price-${provider}-${model}-out`;
                    const overridden = pricing.override[provider as AiProvider]?.[model] !== undefined;
                    // The shipped default doubles as the field placeholder: an admin
                    // can SEE it (empty field shows it) and RESTORE it (clear the field).
                    const def = pricing.default[provider as AiProvider]?.[model];
                    const defIn = def ? String(def.inputPerMtok) : undefined;
                    const defOut = def ? String(def.outputPerMtok) : undefined;
                    return (
                      <div key={model} className="grid grid-cols-[1fr_7rem_7rem] items-center gap-2">
                        <label htmlFor={inId} className={cn('truncate font-mono text-xs', overridden && 'font-semibold')} title={model}>
                          {model}
                          {overridden && <span className="ml-1.5 text-[10px] font-normal text-primary">{t('aiUsage.overridden')}</span>}
                        </label>
                        <Input
                          id={inId}
                          type="number"
                          min={0}
                          step="any"
                          inputSize="sm"
                          className="text-right tabular-nums"
                          aria-label={t('aiUsage.inputPriceFor', {model})}
                          placeholder={defIn}
                          value={draft[provider]?.[model]?.input ?? ''}
                          onChange={(e) => setPrice(provider, model, 'input', e.target.value)}
                        />
                        <Input
                          id={outId}
                          type="number"
                          min={0}
                          step="any"
                          inputSize="sm"
                          className="text-right tabular-nums"
                          aria-label={t('aiUsage.outputPriceFor', {model})}
                          placeholder={defOut}
                          value={draft[provider]?.[model]?.output ?? ''}
                          onChange={(e) => setPrice(provider, model, 'output', e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void savePricing()} disabled={savingPrice}>
            {savingPrice ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {t('aiUsage.savePricing')}
          </Button>
          {priceSaved && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('aiUsage.saved')}</span>}
        </div>
      </SettingsSection>

      {/* ── Retention ────────────────────────────────────────────────────── */}
      <SettingsSection title={t('aiUsage.retentionTitle')} description={t('aiUsage.retentionHint')}>
        <div className="flex items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ai-usage-retention" className="text-sm font-medium">
              {t('aiUsage.retentionLabel')}
            </label>
            <Input
              id="ai-usage-retention"
              type="number"
              min={1}
              step={1}
              inputSize="sm"
              className="w-32 tabular-nums"
              value={retention}
              onChange={(e) => {
                setRetentionSaved(false);
                setRetention(e.target.value);
              }}
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => void saveRetention()} disabled={savingRetention}>
            {savingRetention ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {t('aiUsage.saveRetention')}
          </Button>
          {retentionSaved && <span className="pb-1.5 text-xs text-emerald-600 dark:text-emerald-400">{t('aiUsage.saved')}</span>}
        </div>
      </SettingsSection>
    </div>
  );
}

/** A single labelled summary figure in the usage totals grid. */
function SummaryStat({label, value}: {label: string; value: string}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
