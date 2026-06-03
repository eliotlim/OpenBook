import type {DataClient} from './client';
import type {PageInput, PageSnapshot, StoredPage} from './types';

/**
 * A known-good document that exercises the reactive blocks end to end, plus a
 * one-call seeder for it. A `months` slider feeds an expression that emits four
 * compound-growth curves, which a chart plots. Used by the `seed` CLI command
 * and the in-app "Insert sample document" action so testing and dogfooding
 * never need a document rebuilt by hand.
 */

/** Name of the seeded page. Unique (page names are), so re-seeding is idempotent. */
export const SAMPLE_DOCUMENT_NAME = 'Compound Growth (sample)';

// Stable block ids double as reactive-store cellIds — the editor maps each
// block's id to its cellId. They must stay in sync with the `values`/`names`
// pairs and the expression's `__C__{…}__` reference tokens below.
const MONTHS_CELL = 'sample-months';
const GROWTH_CELL = 'sample-growth';

const INITIAL_MONTHS = 120;

// ExprBlock persists `@name` cell references as `__C__{<cellId>}__` tokens (see
// reactive/compile.ts). This is `@months` already resolved to the slider's cell.
const MONTHS_REF = `__C__{${MONTHS_CELL}}__`;

const GROWTH_SOURCE = `{series: [
  {name: '3%',  data: Array.from({length: ${MONTHS_REF}}, (_, i) => Math.pow(1.03, i / 12))},
  {name: '5%',  data: Array.from({length: ${MONTHS_REF}}, (_, i) => Math.pow(1.05, i / 12))},
  {name: '7%',  data: Array.from({length: ${MONTHS_REF}}, (_, i) => Math.pow(1.07, i / 12))},
  {name: '10%', data: Array.from({length: ${MONTHS_REF}}, (_, i) => Math.pow(1.10, i / 12))},
]}`;

/** Build the sample document as a {@link PageInput} (no id → a fresh page). */
export function buildSampleDocument(): PageInput {
  const data: PageSnapshot = {
    editorjs: {
      blocks: [
        {
          id: 'sample-intro',
          type: 'paragraph',
          data: {
            text: 'Sample reactive document. Drag <b>months</b> to watch four compound-growth curves (3 / 5 / 7 / 10% annual) recompute live.',
          },
        },
        {
          id: MONTHS_CELL,
          type: 'slider',
          data: {name: 'months', min: 1, max: 360, step: 1, initial: INITIAL_MONTHS},
        },
        {
          id: GROWTH_CELL,
          type: 'expr',
          data: {name: 'growth', source: GROWTH_SOURCE},
        },
        {
          id: 'sample-chart',
          type: 'chart',
          data: {refCellIds: [GROWTH_CELL]},
        },
      ],
    },
    // Seed the slider's value; `growth` recomputes reactively on load and the
    // chart re-renders from it.
    values: [[MONTHS_CELL, INITIAL_MONTHS]],
    // name → cellId, so the expression renders the "months" token and the chart
    // picker shows "growth".
    names: [
      ['months', MONTHS_CELL],
      ['growth', GROWTH_CELL],
    ],
  };
  return {name: SAMPLE_DOCUMENT_NAME, data};
}

/**
 * Upsert the sample document through a data client and return the stored page.
 * Idempotent: reuses the existing sample page's id (names are unique) so
 * re-seeding refreshes it in place instead of 409-ing on the name conflict.
 */
export async function seedSampleDocument(client: DataClient): Promise<StoredPage> {
  const existing = (await client.listPages()).find((p) => p.name === SAMPLE_DOCUMENT_NAME);
  const input = buildSampleDocument();
  return client.savePage(existing ? {...input, id: existing.id} : input);
}
