/**
 * LGR-15 — the ledger performance benchmarks, thresholds ASSERTED.
 *
 * Two board-set budgets, on BOTH storage backends (PGlite embedded; external
 * Postgres via `OPENBOOK_TEST_DATABASE_URL`, REQUIRED under
 * `OPENBOOK_REQUIRE_LEDGER_PG=1` — the CI durability job's setting):
 *
 *  1. TRIAL BALANCE over 10k postings   < 500 ms
 *     Measured end-to-end as the report block experiences it: one full
 *     `listTransactions` read (the 10k postings ride on exactly 1000
 *     transactions — `LEDGER_MAX_TRANSACTION_LIMIT`, the report's single-page
 *     read; see `buildLedgerBenchBook`) plus the SHIPPED plugin fold
 *     (`buildTrialBalance` from `examples/plugins/ledger/src/reports`, the
 *     same sources the loader executes — never a re-implementation).
 *
 *  2. 1k-row IMPORT                     < 5 s
 *     Measured as the LGR-10 import block's apply loop actually writes: 1000
 *     sequential `createDraft` calls of two legs each (bank + category — the
 *     importer's draft shape). Drafts, not posts: the importer creates drafts
 *     and posting happens per-row at confirm time.
 *
 * ANTI-FLAKE STRUCTURE (wall-clock in CI is noisy; these are the mitigations,
 * and what they deliberately do NOT do):
 *  - one UNMEASURED warm-up run first (JIT, page cache, PGlite WASM warm-up);
 *  - the asserted number is the MEDIAN of N runs (N=7 for the read benchmark,
 *    N=3 for the write benchmark), so a single GC pause or scheduler hiccup
 *    cannot fail the job — only a shift of the distribution's middle can;
 *  - `OPENBOOK_BENCH_TIME_MULTIPLIER` scales the thresholds for slow LOCAL
 *    machines (documented in docs/ledger/backup-restore.md). CI does NOT set
 *    it: the asserted budgets in the proof job are the board's own numbers,
 *    ×1. A multiplier baked into CI would green a job that asserts a weaker
 *    property than the acceptance criterion — the padded-threshold sin.
 *  - The thresholds still FAIL on a real regression: the measured baselines
 *    sit well under budget (reported in the job summary every run), so the
 *    budget is headroom against machine noise, not against algorithmic change
 *    — an O(n²) slip on a 10k-posting read blows through 500 ms on any
 *    hardware CI has ever used.
 *
 * Every run's numbers are printed and, when `GITHUB_STEP_SUMMARY` is set,
 * appended to the job summary as a markdown table.
 *
 * Kept OUT of the default `test` script (`*.bench.ts` is not matched by
 * `vitest.config.ts`) so `pnpm verify` never inherits wall-clock flake; run
 * via `pnpm --filter @book.dev/server run bench:ledger`.
 */

import {appendFileSync} from 'node:fs';
import {afterAll, describe, expect, it} from 'vitest';
import {
  LEDGER_BENCH_POSTING_COUNT,
  LEDGER_MAX_TRANSACTION_LIMIT,
  buildLedgerBenchBook,
} from '@book.dev/sdk';
// The plugin's OWN LGR-8 fold, from the shipped sources (the same import the
// LGR-13 gate uses; `@book.dev/plugin-sdk` aliases to the sdk, as at runtime).
import {buildTrialBalance} from '../../../examples/plugins/ledger/src/reports';
import {PageStore} from './store';
import {
  SEED_ACTOR,
  externalPgRequired,
  externalPgUrl,
  provisionPglite,
  provisionPostgres,
  seedLedgerFromFixture,
  type ProvisionedDb,
} from './ledgerFixtureSeed';

const TRIAL_BALANCE_BUDGET_MS = 500;
const IMPORT_1K_BUDGET_MS = 5_000;

/** Local-machine escape hatch ONLY — CI asserts the board's numbers at ×1. */
const MULTIPLIER = (() => {
  const raw = Number(process.env.OPENBOOK_BENCH_TIME_MULTIPLIER ?? '1');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

const PG_URL = externalPgUrl();
if (!PG_URL && !externalPgRequired()) {
  console.warn(
    '[LGR-15] benchmarks: external-Postgres half SKIPPED — set OPENBOOK_TEST_DATABASE_URL to a Postgres ' +
      'server that scratch databases may be created on. The CI durability job runs it against a pinned ' +
      'service container regardless.',
  );
}

it('the external-Postgres backend is present when REQUIRED (CI durability job)', () => {
  if (externalPgRequired()) {
    expect(PG_URL, 'OPENBOOK_REQUIRE_LEDGER_PG=1 but OPENBOOK_TEST_DATABASE_URL is unset').not.toBeNull();
  }
});

const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

interface BenchRow {
  backend: string;
  metric: string;
  medianMs: number;
  samplesMs: number[];
  budgetMs: number;
}

const results: BenchRow[] = [];

afterAll(() => {
  if (results.length === 0) return;
  const fmt = (n: number): string => n.toFixed(1);
  const lines = [
    '### LGR-15 ledger benchmarks',
    '',
    `Thresholds asserted at ×${MULTIPLIER} (median of N; warm-up excluded).`,
    '',
    '| backend | metric | median | budget | runs (ms) | verdict |',
    '|---|---|---:|---:|---|---|',
    ...results.map((r) => {
      const budget = r.budgetMs * MULTIPLIER;
      return `| ${r.backend} | ${r.metric} | ${fmt(r.medianMs)} ms | ${fmt(budget)} ms | ${r.samplesMs.map(fmt).join(', ')} | ${r.medianMs < budget ? 'PASS' : 'FAIL'} |`;
    }),
    '',
  ].join('\n');
  console.log(`\n${lines}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines}\n`);
});

function backends(): Array<{backend: 'pglite' | 'postgres'; provision: () => Promise<ProvisionedDb>}> {
  const out: Array<{backend: 'pglite' | 'postgres'; provision: () => Promise<ProvisionedDb>}> = [
    {backend: 'pglite', provision: () => provisionPglite('ob-lgr15-bench-')},
  ];
  if (PG_URL) out.push({backend: 'postgres', provision: () => provisionPostgres(PG_URL)});
  return out;
}

describe.each(backends())('LGR-15 — ledger benchmarks [$backend]', ({backend, provision}) => {
  it(
    `trial balance over ${LEDGER_BENCH_POSTING_COUNT} postings stays under ${TRIAL_BALANCE_BUDGET_MS} ms`,
    async () => {
      const env = await provision();
      try {
        const store = new PageStore(env.db);
        await seedLedgerFromFixture(store, buildLedgerBenchBook());

        const run = async (): Promise<{ms: number; postings: number; differenceMinor: number; totalDebitMinor: number}> => {
          const started = performance.now();
          const accounts = await store.ledger.listAccounts();
          const transactions = await store.ledger.listTransactions({limit: LEDGER_MAX_TRANSACTION_LIMIT});
          const tb = buildTrialBalance(accounts, transactions);
          const ms = performance.now() - started;
          const postings = transactions.reduce((n, t) => n + t.postings.length, 0);
          return {ms, postings, differenceMinor: tb.differenceMinor, totalDebitMinor: tb.totalDebitMinor};
        };

        await run(); // warm-up, unmeasured
        const samples: number[] = [];
        for (let i = 0; i < 7; i += 1) {
          const {ms, postings, differenceMinor, totalDebitMinor} = await run();
          // Green-on-nothing guards: the timed read really saw the whole book
          // and the fold really produced a balanced report.
          expect(postings).toBe(LEDGER_BENCH_POSTING_COUNT);
          expect(differenceMinor).toBe(0);
          expect(totalDebitMinor).toBeGreaterThan(0);
          samples.push(ms);
        }
        const med = median(samples);
        results.push({backend, metric: `trial balance @ ${LEDGER_BENCH_POSTING_COUNT} postings`, medianMs: med, samplesMs: samples, budgetMs: TRIAL_BALANCE_BUDGET_MS});
        expect(med, `trial balance median ${med.toFixed(1)} ms over budget (samples: ${samples.map((s) => s.toFixed(1)).join(', ')})`).toBeLessThan(TRIAL_BALANCE_BUDGET_MS * MULTIPLIER);
      } finally {
        await env.destroy();
      }
    },
    600_000,
  );

  it(
    `importing 1k rows as drafts stays under ${IMPORT_1K_BUDGET_MS} ms`,
    async () => {
      const env = await provision();
      try {
        const store = new PageStore(env.db);
        await store.ledger.ensureSetup(SEED_ACTOR);
        const bank = await store.ledger.createAccount({name: 'Assets:Bank:Checking', type: 'asset'}, SEED_ACTOR);
        const category = await store.ledger.createAccount({name: 'Expenses:Imported', type: 'expense'}, SEED_ACTOR);

        const importRows = async (count: number, tag: string): Promise<number> => {
          const started = performance.now();
          for (let i = 0; i < count; i += 1) {
            await store.ledger.createDraft(
              {
                date: '2026-03-01',
                description: `stmt ${tag} row ${i}`,
                postings: [
                  {accountId: bank.id, amountMinor: -(100 + i)},
                  {accountId: category.id, amountMinor: 100 + i},
                ],
              },
              SEED_ACTOR,
            );
          }
          return performance.now() - started;
        };

        await importRows(100, 'warmup'); // warm-up, unmeasured
        const samples: number[] = [];
        for (let batch = 0; batch < 3; batch += 1) {
          samples.push(await importRows(1000, `b${batch}`));
        }
        // Guard: the drafts really landed (3 measured batches + warm-up).
        const drafts = await store.ledger.listTransactions({state: 'draft', limit: LEDGER_MAX_TRANSACTION_LIMIT});
        expect(drafts.length).toBe(LEDGER_MAX_TRANSACTION_LIMIT);
        const med = median(samples);
        results.push({backend, metric: 'import 1k rows (drafts)', medianMs: med, samplesMs: samples, budgetMs: IMPORT_1K_BUDGET_MS});
        expect(med, `1k-row import median ${med.toFixed(1)} ms over budget (samples: ${samples.map((s) => s.toFixed(1)).join(', ')})`).toBeLessThan(IMPORT_1K_BUDGET_MS * MULTIPLIER);
      } finally {
        await env.destroy();
      }
    },
    600_000,
  );
});
