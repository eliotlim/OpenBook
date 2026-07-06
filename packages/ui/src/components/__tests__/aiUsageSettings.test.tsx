import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import type {AiPricingResponse, AiUsageResponse, DataClient, InstanceInfo} from '@book.dev/sdk';
import {guestPrincipal} from '@book.dev/sdk';
import AiUsageSettings from '../settings/AiUsageSettings';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <AiUsageSettings />
      </DataProvider>
    </I18nProvider>,
  );

const OPUS = {inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25};

const pricing = (over: Partial<AiPricingResponse> = {}): AiPricingResponse => ({
  default: {claude: {'claude-opus-4-8': OPUS}},
  override: {},
  effective: {claude: {'claude-opus-4-8': OPUS}},
  ...over,
});

const usageWithRows = (): AiUsageResponse => ({
  exists: true,
  databaseId: 'd1',
  hostPageId: 'h1',
  retentionDays: 30,
  rows: [
    {
      id: 'r1',
      time: '2026-07-06T10:00:00.000Z',
      user: 'acct#ada (Ada)',
      provider: 'claude',
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.0175,
      kind: 'generate',
    },
  ],
  totals: {rows: 1, inputTokens: 1000, outputTokens: 500, cost: 0.0175},
});

const emptyUsage: AiUsageResponse = {exists: false, databaseId: null, hostPageId: null, retentionDays: null};

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  guestAccess: 'write',
  ownerSubject: 'acct#owner',
  trustedIssuers: [],
  audience: null,
  you: guestPrincipal('Ada'),
  youRole: 'admin',
  ...over,
});

const adminClient = (over: Partial<DataClient> = {}): Partial<DataClient> => ({
  getInstanceInfo: async () => info(),
  getAiPricing: async () => pricing(),
  getAiUsage: async () => usageWithRows(),
  setAiPricing: vi.fn(async (o) => pricing({override: o, effective: {claude: {'claude-opus-4-8': {...OPUS, ...o.claude?.['claude-opus-4-8']}}}})),
  setAiUsageRetention: vi.fn(async (days: number) => ({days})),
  ...over,
});

afterEach(() => cleanup());

describe('AiUsageSettings (admin AI usage + pricing)', () => {
  it('shows the usage viewer, pricing editor and retention control to an admin', async () => {
    wrap(adminClient());
    expect(await screen.findByTestId('ai-usage-admin')).toBeTruthy();
    // Usage viewer: totals + a row.
    expect(screen.getByLabelText('Recent AI usage')).toBeTruthy();
    expect(screen.getByText('acct#ada (Ada)')).toBeTruthy();
    // Pricing editor: the model's editable input seeded from the effective price.
    expect((screen.getByLabelText('Input price per million tokens for claude-opus-4-8') as HTMLInputElement).value).toBe('5');
    // Retention control.
    expect((screen.getByLabelText('Retention (days)') as HTMLInputElement).value).toBe('30');
  });

  it('renders NOTHING for a viewer — never even probes the admin endpoints', async () => {
    const getAiPricing = vi.fn();
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => info({youRole: 'viewer'}),
      getAiPricing,
    };
    wrap(client);
    await waitFor(() => expect(client.getInstanceInfo).toBeDefined());
    // The fast-path role gate hides before the pricing/usage probe fires.
    await waitFor(() => expect(screen.queryByTestId('ai-usage-admin')).toBeNull());
    expect(getAiPricing).not.toHaveBeenCalled();
  });

  it('renders NOTHING for a guest that 403s the admin endpoints (hide-not-break)', async () => {
    const getAiPricing = vi.fn(async () => {
      throw new Error('OpenBook request failed (403 Forbidden): only the instance owner or an admin');
    });
    const client: Partial<DataClient> = {
      getInstanceInfo: async () => {
        throw new Error('404'); // inconclusive → fall through to the endpoint 403
      },
      getAiPricing,
      getAiUsage: async () => {
        throw new Error('403');
      },
    };
    wrap(client);
    await waitFor(() => expect(getAiPricing).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('ai-usage-admin')).toBeNull());
  });

  it('persists an edited model price as an override and round-trips the new value', async () => {
    const setAiPricing = vi.fn(async (o: Parameters<DataClient['setAiPricing']>[0]) =>
      pricing({override: o, effective: {claude: {'claude-opus-4-8': {...OPUS, inputPerMtok: 9}}}}),
    );
    wrap(adminClient({setAiPricing}));
    const input = (await screen.findByLabelText('Input price per million tokens for claude-opus-4-8')) as HTMLInputElement;
    expect(input.value).toBe('5');

    fireEvent.change(input, {target: {value: '9'}});
    fireEvent.click(screen.getByText('Save pricing'));

    await waitFor(() => expect(setAiPricing).toHaveBeenCalledTimes(1));
    // Only the changed model is sent, carrying the effective cache prices.
    expect(setAiPricing).toHaveBeenCalledWith({
      claude: {'claude-opus-4-8': {inputPerMtok: 9, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25}},
    });
    // Round-trip: the reloaded effective value re-seeds the field.
    await waitFor(() => expect((screen.getByLabelText('Input price per million tokens for claude-opus-4-8') as HTMLInputElement).value).toBe('9'));
  });

  it('surfaces the shipped default as a placeholder and restores it by clearing the field', async () => {
    const setAiPricing = vi.fn(async () => pricing());
    // An override is in effect (input repriced to 9); the default (5) stays discoverable.
    const overridden = pricing({
      override: {claude: {'claude-opus-4-8': {inputPerMtok: 9, outputPerMtok: 25}}},
      effective: {claude: {'claude-opus-4-8': {...OPUS, inputPerMtok: 9}}},
    });
    wrap(adminClient({getAiPricing: async () => overridden, setAiPricing}));
    const input = (await screen.findByLabelText('Input price per million tokens for claude-opus-4-8')) as HTMLInputElement;
    expect(input.value).toBe('9');
    expect(input.getAttribute('placeholder')).toBe('5'); // the shipped default is visible

    // Clearing the field drops the override for that model → it falls back to the default.
    fireEvent.change(input, {target: {value: ''}});
    fireEvent.click(screen.getByText('Save pricing'));
    await waitFor(() => expect(setAiPricing).toHaveBeenCalledTimes(1));
    expect(setAiPricing).toHaveBeenCalledWith({}); // no override → default applies
  });

  it('formats the total-cost summary to 2dp while keeping the per-row cost at 4dp', async () => {
    wrap(adminClient());
    await screen.findByTestId('ai-usage-admin');
    expect(screen.getByText('$0.02')).toBeTruthy(); // summary card: 0.0175 → $0.02
    expect(screen.getByText('$0.0175')).toBeTruthy(); // per-row cost keeps 4dp
  });

  it('shows a row-cap hint when the total call count exceeds the shown rows', async () => {
    const many: AiUsageResponse = {...usageWithRows(), totals: {rows: 150, inputTokens: 1000, outputTokens: 500, cost: 0.0175}};
    wrap(adminClient({getAiUsage: async () => many}));
    expect(await screen.findByText(/Showing the latest 1 of 150 calls/)).toBeTruthy();
  });

  it('the retention control calls setAiUsageRetention with the entered days', async () => {
    const setAiUsageRetention = vi.fn(async (days: number) => ({days}));
    wrap(adminClient({setAiUsageRetention, getAiUsage: async () => usageWithRows()}));
    const field = (await screen.findByLabelText('Retention (days)')) as HTMLInputElement;
    fireEvent.change(field, {target: {value: '7'}});
    fireEvent.click(screen.getByText('Save retention'));
    await waitFor(() => expect(setAiUsageRetention).toHaveBeenCalledWith(7));
  });

  it('shows a graceful empty state (no table) when no usage has been recorded', async () => {
    wrap(adminClient({getAiUsage: async () => emptyUsage}));
    expect(await screen.findByTestId('ai-usage-admin')).toBeTruthy();
    expect(screen.getByText(/No AI usage recorded yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Recent AI usage')).toBeNull();
    // The pricing editor is still available even before any usage exists.
    expect(screen.getByText('Model pricing')).toBeTruthy();
  });
});
