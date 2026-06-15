import type {DataClient} from './client';
import type {PageInput, PageSnapshot, StoredPage} from './types';

/**
 * A known-good document that exercises the reactive blocks end to end, plus a
 * one-call seeder for it. A `months` slider feeds a live code block that emits
 * four compound-growth curves, which a kit chart plots. Used by the `seed` CLI
 * command and the in-app "Insert sample document" action so testing and
 * dogfooding never need a document rebuilt by hand.
 *
 * Authored as a **block-doc** (`editor: 'blocks'` + a `blockdoc.blocks` JSON
 * projection), the same native shape the gallery templates use — NOT the legacy
 * EditorJS form. (The old EditorJS version migrated its `chart` block into a
 * "not supported" warning callout, since the migration has no chart target; the
 * native `kitchart` block renders the curves directly.)
 */

/** Name of the seeded page. Unique (page names are), so re-seeding is idempotent. */
export const SAMPLE_DOCUMENT_NAME = 'Compound Growth (sample)';

const INITIAL_MONTHS = 120;

// `months` is published by the slider; this live block reads it and returns an
// object of named arrays — the multi-series shape the kit chart plots (one line
// per annual rate). Returning bare arrays here would collapse to a single line.
const GROWTH_SOURCE = `return {
  '3%':  Array.from({length: months}, (_, i) => Math.pow(1.03, i / 12)),
  '5%':  Array.from({length: months}, (_, i) => Math.pow(1.05, i / 12)),
  '7%':  Array.from({length: months}, (_, i) => Math.pow(1.07, i / 12)),
  '10%': Array.from({length: months}, (_, i) => Math.pow(1.10, i / 12)),
};`;

/** The reactive sample as a block-doc projection (ids double as stable block ids). */
const SAMPLE_BLOCKS = [
  {
    id: 'sample-intro',
    type: 'paragraph',
    text: [
      {t: 'Sample reactive document. Drag '},
      {t: 'months', a: {b: true}},
      {t: ' to watch four compound-growth curves (3 / 5 / 7 / 10% annual) recompute live.'},
    ],
  },
  {id: 'sample-months', type: 'slider', props: {name: 'months', label: 'Months', value: INITIAL_MONTHS, min: 1, max: 360}},
  {
    id: 'sample-growth',
    type: 'code',
    text: [{t: GROWTH_SOURCE}],
    props: {live: true, name: 'growth', language: 'js', collapsed: true},
  },
  {id: 'sample-chart', type: 'kitchart', props: {kind: 'line', title: 'Growth of £1 by annual rate', source: 'growth'}},
];

/** Build the sample document as a {@link PageInput} (no id → a fresh page). */
export function buildSampleDocument(): PageInput {
  const data: PageSnapshot = {
    editorjs: {blocks: []},
    values: [],
    names: [],
    editor: 'blocks',
    blockdoc: {blocks: SAMPLE_BLOCKS},
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
